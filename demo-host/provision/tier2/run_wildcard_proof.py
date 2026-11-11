#!/usr/bin/env python3
"""Runs real Caddy against a local ACME CA and records what each side saw.

For every case directory under --work (a rendered `Caddyfile`, a `dns-token`
file and a `case.json`) this starts pebble-challtestsrv, a DNS front that
answers the zone lookups challtestsrv does not, Pebble, and the test-only
Caddy, waits for Caddy to obtain its certificates, probes the served
certificates over TLS, and copies every log and a `result.json` to --out.
It judges nothing: demo-host/provision/test_demo_edge_tier2.py reads the
artifacts and decides. See test_demo_edge_tier2.md.

Standard library only, so the same file runs in the image and, for
development, on a machine with the binaries named by --bin-dir.

Usage: run_wildcard_proof.py --work DIR --out DIR --scratch DIR --bin-dir DIR
"""

from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import pathlib
import shutil
import socket
import ssl
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from typing import Iterator, Mapping, Sequence

LOOPBACK = "127.0.0.1"
HTTP_PORT = 18080
HTTPS_PORT = 18443
ACME_PORT = 14000
PEBBLE_MANAGEMENT_PORT = 15000
CHALLTESTSRV_DNS_PORT = 8053
CHALLTESTSRV_MANAGEMENT_PORT = 8055
DNS_FRONT_PORT = 8054
CADDY_BINARY = "caddy-tier2"
OBTAINED_MARKER = '"certificate obtained successfully"'
STORED_CERTIFICATES_DIRECTORY = "caddy/certificates"
STARTUP_SECONDS = 30
OBTAIN_SECONDS = 120
PROBE_SECONDS = 10
STOP_SECONDS = 10

# The renderer's global block, the only part of its output a proof may edit.
GLOBAL_BLOCK = "{\n\tadmin off\n}\n"


class ProofRunError(RuntimeError):
    """A component of the harness did not start, or a case file is unusable."""


class SandboxEditError(ValueError):
    """The Caddyfile does not carry the renderer's global block exactly once."""


@dataclass(frozen=True)
class CaseSpec:
    base: str
    expected_certificates: int
    probe_names: tuple[str, ...]


def acme_directory_url() -> str:
    return f"https://{LOOPBACK}:{ACME_PORT}/dir"


def sandbox_global_block(ca_root: str) -> str:
    """The global block with only what a sandbox needs added to `admin off`:
    unprivileged ports, no redirect listener, the local CA and its root, and
    the DNS front as the resolver for challenge lookups."""
    return "".join(
        [
            "{\n\tadmin off\n",
            f"\thttp_port {HTTP_PORT}\n",
            f"\thttps_port {HTTPS_PORT}\n",
            "\tauto_https disable_redirects\n",
            f"\tacme_ca {acme_directory_url()}\n",
            f"\tacme_ca_root {ca_root}\n",
            f"\ttls_resolvers {LOOPBACK}:{DNS_FRONT_PORT}\n",
            "}\n",
        ]
    )


def sandbox_caddyfile(caddyfile: str, ca_root: str) -> str:
    """Replaces the renderer's global block and touches nothing else.
    Raises SandboxEditError unless that block occurs exactly once."""
    if caddyfile.count(GLOBAL_BLOCK) != 1:
        raise SandboxEditError("the Caddyfile does not contain the renderer's global block exactly once")
    before, _block, after = caddyfile.partition(GLOBAL_BLOCK)
    return before + sandbox_global_block(ca_root) + after


def load_case(path: pathlib.Path) -> CaseSpec:
    """Raises ProofRunError for a case file that is not the expected shape."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    base, expected, names = raw.get("base"), raw.get("expected_certificates"), raw.get("probe_names")
    if not isinstance(base, str) or not isinstance(expected, int) or not isinstance(names, list):
        raise ProofRunError(f"{path} is not a case file")
    if not all(isinstance(name, str) for name in names):
        raise ProofRunError(f"{path} lists a probe name that is not a string")
    return CaseSpec(base, expected, tuple(names))


def start(
    argv: Sequence[str],
    log_path: pathlib.Path,
    environ: Mapping[str, str] | None = None,
    cwd: pathlib.Path | None = None,
) -> subprocess.Popen[bytes]:
    with log_path.open("wb") as log:
        return subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT, env=environ, cwd=cwd)


def stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=STOP_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


@contextlib.contextmanager
def running(processes: list[subprocess.Popen[bytes]]) -> Iterator[None]:
    """Stops every process on exit, last started first."""
    try:
        yield
    finally:
        for process in reversed(processes):
            stop(process)


def wait_for_port(port: int, label: str) -> None:
    """Raises ProofRunError when nothing listens on the loopback port in time."""
    deadline = time.monotonic() + STARTUP_SECONDS
    while time.monotonic() < deadline:
        with contextlib.suppress(OSError), socket.create_connection((LOOPBACK, port), timeout=1):
            return
        time.sleep(0.2)
    raise ProofRunError(f"{label} did not listen on port {port}")


def count_obtained(log_path: pathlib.Path) -> int:
    return log_path.read_text(encoding="utf-8", errors="replace").count(OBTAINED_MARKER)


def wait_for_certificates(caddy: subprocess.Popen[bytes], log_path: pathlib.Path, expected: int) -> int:
    """Waits until Caddy has obtained `expected` certificates, exits, or the
    time is up, and returns how many it obtained. It never raises: a shortfall
    is a finding for the judge, not a harness failure."""
    deadline = time.monotonic() + OBTAIN_SECONDS
    while time.monotonic() < deadline and caddy.poll() is None:
        if count_obtained(log_path) >= expected:
            break
        time.sleep(0.5)
    return count_obtained(log_path)


def fetch_pebble_root(ca_certificate: pathlib.Path) -> str:
    context = ssl.create_default_context(cafile=str(ca_certificate))
    url = f"https://{LOOPBACK}:{PEBBLE_MANAGEMENT_PORT}/roots/0"
    with urllib.request.urlopen(url, context=context, timeout=PROBE_SECONDS) as response:
        return response.read().decode("ascii")


def dns_names(certificate: Mapping[str, object] | None) -> list[str]:
    entries = certificate.get("subjectAltName", ()) if certificate else ()
    names: list[str] = []
    for entry in entries if isinstance(entries, tuple) else ():
        if isinstance(entry, tuple) and len(entry) == 2 and entry[0] == "DNS":
            names.append(str(entry[1]))
    return names


def first_response_status(connection: http.client.HTTPSConnection) -> int | None:
    """The status of GET /, or None when the server closed without answering."""
    try:
        connection.request("GET", "/")
        return connection.getresponse().status
    except (http.client.RemoteDisconnected, ConnectionError):
        return None


def probe(name: str, context: ssl.SSLContext) -> dict[str, object]:
    """Connects to Caddy with `name` as the SNI, verifying against Pebble's
    root and `name`, and records the TLS outcome, the certificate's DNS names
    and how a GET / ended."""
    outcome: dict[str, object] = {
        "name": name,
        "tls_verified": False,
        "tls_error": "",
        "san_dns": [],
        "http_status": None,
        "closed_without_response": False,
    }
    try:
        raw = socket.create_connection((LOOPBACK, HTTPS_PORT), timeout=PROBE_SECONDS)
    except OSError as error:
        outcome["tls_error"] = f"connect: {error}"
        return outcome
    try:
        secured = context.wrap_socket(raw, server_hostname=name)
    except OSError as error:
        raw.close()
        outcome["tls_error"] = f"{type(error).__name__}: {error}"
        return outcome
    outcome["tls_verified"] = True
    outcome["san_dns"] = dns_names(secured.getpeercert())
    connection = http.client.HTTPSConnection(name, HTTPS_PORT, timeout=PROBE_SECONDS, context=context)
    connection.sock = secured
    try:
        status = first_response_status(connection)
    finally:
        connection.close()
    outcome["http_status"] = status
    outcome["closed_without_response"] = status is None
    return outcome


def stored_certificate_names(data_home: pathlib.Path) -> list[str]:
    """The certificate directories in Caddy's storage, one per managed name."""
    root = data_home / STORED_CERTIFICATES_DIRECTORY
    return sorted(path.name for issuer in root.glob("*") for path in issuer.glob("*") if path.is_dir())


def start_ca_stack(
    bin_dir: pathlib.Path, scratch: pathlib.Path, out: pathlib.Path, spec: CaseSpec
) -> list[subprocess.Popen[bytes]]:
    """Starts challtestsrv, the DNS front and Pebble, and returns them once
    their ports answer. Pebble gets a fresh throwaway TLS identity."""
    subprocess.run([str(bin_dir / "mkcert"), str(scratch)], check=True)
    config = {
        "pebble": {
            "listenAddress": f"{LOOPBACK}:{ACME_PORT}",
            "managementListenAddress": f"{LOOPBACK}:{PEBBLE_MANAGEMENT_PORT}",
            "certificate": str(scratch / "cert.pem"),
            "privateKey": str(scratch / "key.pem"),
            "httpPort": 5002,
            "tlsPort": 5001,
            "ocspResponderURL": "",
            "externalAccountBindingRequired": False,
            "domainBlocklist": [],
            "retryAfter": {"authz": 1, "order": 1},
            "keyAlgorithm": "ecdsa",
            "profiles": {"default": {"description": "default", "validityPeriod": 7776000}},
        }
    }
    (scratch / "pebble-config.json").write_text(json.dumps(config), encoding="utf-8")
    environ = {"PATH": "/usr/bin:/bin", "PEBBLE_VA_NOSLEEP": "1", "PEBBLE_WFE_NONCEREJECT": "0", "PEBBLE_AUTHZREUSE": "0"}
    dns_upstream = f"{LOOPBACK}:{CHALLTESTSRV_DNS_PORT}"
    processes = [
        start(
            [str(bin_dir / "pebble-challtestsrv"), "-http01", "", "-https01", "", "-tlsalpn01", "", "-doh", "",
             "-dnsserver", dns_upstream, "-management", f"{LOOPBACK}:{CHALLTESTSRV_MANAGEMENT_PORT}"],
            out / "challtestsrv.log",
        ),
        start([str(bin_dir / "soashim"), f"{LOOPBACK}:{DNS_FRONT_PORT}", spec.base, dns_upstream], out / "soashim.log"),
        start([str(bin_dir / "pebble"), "-config", str(scratch / "pebble-config.json"), "-dnsserver", dns_upstream],
              out / "pebble.log", environ),
    ]
    for port, label in ((CHALLTESTSRV_MANAGEMENT_PORT, "challtestsrv"), (DNS_FRONT_PORT, "dns front"),
                        (PEBBLE_MANAGEMENT_PORT, "pebble")):
        wait_for_port(port, label)
    return processes


def run_case(name: str, work: pathlib.Path, out: pathlib.Path, scratch: pathlib.Path, bin_dir: pathlib.Path) -> None:
    """Raises ProofRunError when a component of the CA stack does not start,
    SandboxEditError for a Caddyfile without the renderer's global block."""
    spec = load_case(work / name / "case.json")
    case_out, case_scratch = out / name, scratch / name
    case_out.mkdir(parents=True)
    case_scratch.mkdir(parents=True)
    caddyfile = case_scratch / "Caddyfile"
    caddyfile.write_text(
        sandbox_caddyfile((work / name / "Caddyfile").read_text(encoding="utf-8"), str(case_scratch / "cert.pem")),
        encoding="utf-8",
    )
    shutil.copy(caddyfile, case_out / "Caddyfile.loaded")
    processes = start_ca_stack(bin_dir, case_scratch, case_out, spec)
    with running(processes):
        caddy_environ = {"PATH": "/usr/bin:/bin", "HOME": str(case_scratch), "XDG_DATA_HOME": str(case_scratch / "xdg"),
                         "XDG_CONFIG_HOME": str(case_scratch / "xdg-config")}
        caddy = start([str(bin_dir / CADDY_BINARY), "run", "--adapter", "caddyfile", "--config", str(caddyfile)],
                      case_out / "caddy.log", caddy_environ, case_scratch)
        processes.append(caddy)
        obtained = wait_for_certificates(caddy, case_out / "caddy.log", spec.expected_certificates)
        context = ssl.create_default_context(cadata=fetch_pebble_root(case_scratch / "cert.pem"))
        probes = [probe(probe_name, context) for probe_name in spec.probe_names]
        stored = stored_certificate_names(case_scratch / "xdg")
    result = {"obtained_certificates": obtained, "stored_certificates": stored, "probes": probes}
    (case_out / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("--work", "--out", "--scratch", "--bin-dir"):
        parser.add_argument(option, required=True, type=pathlib.Path)
    args = parser.parse_args(argv)
    names = sorted(path.parent.name for path in args.work.glob("*/case.json"))
    if not names:
        raise ProofRunError(f"no case.json under {args.work}")
    for name in names:
        run_case(name, args.work, args.out, args.scratch, args.bin_dir)
        print(f"case {name}: recorded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
