"""The test environment: the demo edge as rendered for production, the real gate image, stand-in colours.

Nothing here touches a public slot or a host. Everything runs as containers on
the machine that runs it and is removed when the run ends:

- the colours (stand-in for a slot's Ghost pair, and its health router), which
  own the network namespace the rest join, as the edge, gate and colours share
  one on the demo host;
- the gate, the real image under test, reading the slots file and the lease
  directory the broker writes, here written by this module in the same shapes;
- Caddy, loading the Caddyfile that demo-host/provision/render_demo_site.py
  renders for a gated slot, with a local certificate authority.

Until the pieces that make a slot (the broker's reconcile, the lifecycle
worker) run inside this environment, this module plays the broker's two
writes: the slot's hash and its lease record.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Mapping
from pathlib import Path
from types import TracebackType

from .edge import Recycled, Reply
from .sabotage import Fault
from .visitor import Visitor

# Pinned by digest, in the form the repository's image-mirror guard reads: the
# public namespace by default, the mirror's where IMAGE_REGISTRY names it.
CADDY_IMAGE = "${IMAGE_REGISTRY:-docker.io/library}/caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b"
COLOURS_IMAGE = "${IMAGE_REGISTRY:-docker.io/library}/node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402"

HOST = "slot0.demo.test"
BASE = "demo.test"
SLOT = "0"
# Lease records are ULIDs; these two are the first tenancy's and the next one's.
LEASE_FIRST = "01J9F4Q7ZC3M8V2K6X0R5T1B9D"
LEASE_NEXT = "01J9F4Q7ZC3M8V2K6X0R5T1B9E"

# The global options a local run needs and production does not: a local
# certificate authority, and no installing it into any trust store.
LOCAL_GLOBALS = "\tadmin off\n\tlocal_certs\n\tskip_install_trust\n\tauto_https disable_redirects\n"
PLAIN_GLOBALS = "\tadmin off\n"

_REGISTRY_REF = re.compile(r"\$\{IMAGE_REGISTRY:-([^}]*)\}")


def image_ref(template: str, registry: str | None = None) -> str:
    """Expands `${IMAGE_REGISTRY:-<public namespace>}` as a shell would."""
    chosen = registry if registry else os.environ.get("IMAGE_REGISTRY", "")
    return _REGISTRY_REF.sub(lambda m: chosen or m.group(1), template)


def exempt_ghost(caddyfile: str) -> str:
    """The edge with /ghost/* proxied straight to a colour, outside the gate."""
    marker = "\t\thandle {\n"
    if marker not in caddyfile:
        raise RuntimeError("the rendered Caddyfile has no catch-all handle block to exempt /ghost/* from")
    return caddyfile.replace(
        marker,
        "\t\thandle /ghost/* {\n\t\t\treverse_proxy 127.0.0.1:9300\n\t\t}\n" + marker,
        1,
    )


class StartError(RuntimeError):
    """The environment could not be built or started; no stage is judged by this."""


def _docker(*args: str, stdin: str | None = None, check: bool = True) -> str:
    done = subprocess.run(
        ["docker", *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if check and done.returncode != 0:
        raise StartError(f"docker {' '.join(args[:2])} failed ({done.returncode}): {done.stderr.strip()}")
    return done.stdout


class Environment:
    """A started environment. Use as a context manager; leaving it removes every container and file."""

    def __init__(self, repo_root: Path, gate_image: str, fault: Fault | None = None) -> None:
        self._repo = repo_root
        self._gate_image = gate_image
        self._fault = fault
        self._work = Path(tempfile.mkdtemp(prefix="demo-path-e2e-"))
        os.chmod(self._work, 0o755)
        suffix = secrets.token_hex(4)
        self._colours = f"demo-path-e2e-colours-{suffix}"
        self._gate = f"demo-path-e2e-gate-{suffix}"
        self._caddy = f"demo-path-e2e-caddy-{suffix}"
        self._passphrase = secrets.token_urlsafe(18)
        self._lease = LEASE_FIRST
        self._visitor: Visitor | None = None
        self._issued_hash = ""

    @property
    def passphrase(self) -> str:
        return self._passphrase

    @property
    def lease(self) -> str:
        return self._lease

    def request(
        self,
        method: str,
        path: str,
        *,
        cookie: str = "",
        form: Mapping[str, str] | None = None,
    ) -> Reply:
        if self._visitor is None:
            raise StartError("the environment is not started")
        return self._visitor.request(method, path, cookie=cookie, form=form)

    # The broker's two writes, in the shapes the gate reads. A slot's hash and
    # its lease record are two files written independently; the record carries
    # the hash's id so the gate can tell a pair that belongs together.

    def _hash(self, passphrase: str) -> str:
        return _docker("run", "--rm", "-i", self._gate_image, "node", "dist/hashCli.js", stdin=passphrase).strip()

    def _hash_id(self, phc: str) -> str:
        script = (
            'import("@branchleft/ghost-platform-render-core")'
            ".then((m) => process.stdout.write(m.hashIdOf(process.argv[1])));"
        )
        return _docker("run", "--rm", self._gate_image, "node", "-e", script, phc).strip()

    def _write(self, relative: str, text: str) -> None:
        target = self._work / relative
        staged = target.with_name("." + target.name + ".tmp")
        staged.write_text(text)
        os.chmod(staged, 0o644)
        os.replace(staged, target)

    def _write_slot(self, phc: str, lease: str, hash_id: str) -> None:
        slots = {"slots": [{"host": HOST, "slot": SLOT, "gate": {"kind": "passphrase", "argon2idHash": phc}}]}
        self._write("config/slots.json", json.dumps(slots))
        self._write(f"leases/{SLOT}.json", json.dumps({"slot": SLOT, "lease": lease, "hashId": hash_id}))

    def recycle(self) -> Recycled:
        old_phc = self._issued_hash
        passphrase = secrets.token_urlsafe(18)
        if self._fault is Fault.HASH_NOT_ROTATED:
            # The broker's discipline broken: a new lease, the old hash.
            self._write_slot(old_phc, LEASE_NEXT, self._hash_id(old_phc))
        else:
            phc = self._hash(passphrase)
            self._write_slot(phc, LEASE_NEXT, self._hash_id(phc))
            self._issued_hash = phc
        self._passphrase = passphrase
        self._lease = LEASE_NEXT
        return Recycled(passphrase, LEASE_NEXT)

    def __enter__(self) -> Environment:
        try:
            self._start()
        except BaseException:
            self._dump_logs()
            self.__exit__(None, None, None)
            raise
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        _docker("rm", "-f", self._caddy, self._gate, self._colours, check=False)
        shutil.rmtree(self._work, ignore_errors=True)

    def _dump_logs(self) -> None:
        for name in (self._gate, self._caddy):
            logs = subprocess.run(["docker", "logs", "--tail", "40", name], capture_output=True, text=True, check=False)
            sys.stderr.write(f"--- {name} ---\n{logs.stdout}{logs.stderr}")

    def _start(self) -> None:
        (self._work / "config").mkdir(mode=0o755)
        (self._work / "leases").mkdir(mode=0o755)
        (self._work / "drain").mkdir(mode=0o755)
        key = self._work / "config" / "key"
        key.write_bytes(os.urandom(32))
        os.chmod(key, 0o644)

        # The slot as the broker hands it over: the issued passphrase's hash and the first lease.
        issued = self._hash(self._passphrase)
        self._issued_hash = issued
        # Sabotaged: the hash on file is some other passphrase's.
        on_file = self._hash(secrets.token_urlsafe(18)) if self._fault is Fault.WRONG_HASH else issued
        self._write_slot(on_file, self._lease, self._hash_id(on_file))

        caddyfile = self._render_edge()
        if self._fault is Fault.EXEMPT_GHOST:
            caddyfile = exempt_ghost(caddyfile)
        self._write("Caddyfile", caddyfile)

        proof = self._repo / "scripts" / "demo-edge-proof"
        _docker(
            "run", "-d", "--name", self._colours,
            "-v", f"{proof}:/proof:ro",
            "-v", f"{self._work / 'drain'}:/drain",
            "-p", "127.0.0.1::443",
            image_ref(COLOURS_IMAGE), "node", "/proof/sim.mjs",
        )  # fmt: skip
        _docker(
            "run", "-d", "--name", self._gate, "--network", f"container:{self._colours}",
            "-v", f"{self._work / 'config'}:/etc/demo-gate:ro",
            "-v", f"{self._work / 'leases'}:/run/demo-leases:ro",
            "-e", "GATE_SIGNING_KEY_FILE=/etc/demo-gate/key",
            "-e", "GATE_SLOTS_FILE=/etc/demo-gate/slots.json",
            "-e", "GATE_LEASE_DIR=/run/demo-leases",
            "--env-file", str(self._work / "gate.env"),
            self._gate_image,
        )  # fmt: skip
        _docker(
            "run", "-d", "--name", self._caddy, "--network", f"container:{self._colours}",
            "-v", f"{self._work / 'Caddyfile'}:/etc/caddy/Caddyfile:ro",
            image_ref(CADDY_IMAGE),
        )  # fmt: skip

        root = self._work / "root.crt"
        for _ in range(30):
            copied = subprocess.run(
                ["docker", "cp", f"{self._caddy}:/data/caddy/pki/authorities/local/root.crt", str(root)],
                capture_output=True,
                check=False,
            )
            if copied.returncode == 0 and root.exists() and root.stat().st_size > 0:
                break
            time.sleep(1)
        else:
            raise StartError("Caddy produced no local root certificate")

        published = _docker("port", self._colours, "443/tcp").splitlines()[0]
        port = int(published.rsplit(":", 1)[1])
        self._visitor = Visitor(HOST, port, root)
        for _ in range(30):
            try:
                if self._visitor.request("GET", "/").status == 401:
                    return
            except OSError:
                pass
            time.sleep(1)
        raise StartError("the edge never answered the gate's refusal")

    def _render_edge(self) -> str:
        """The Caddyfile the demo host's own renderer makes for one gated slot."""
        golden = json.loads((self._repo / "render-core" / "test" / "golden" / "demo.edge.json").read_text())
        golden["displayHostname"] = HOST
        edge_json = self._work / "edge.json"
        edge_json.write_text(json.dumps(golden))
        rendered = subprocess.run(
            [
                sys.executable,
                str(self._repo / "demo-host" / "provision" / "render_demo_site.py"),
                "--base", BASE,
                "--site", f"{SLOT}={edge_json}",
                "--tls", "tls internal",
                "--gate-env-out", str(self._work / "gate.env"),
            ],
            capture_output=True,
            text=True,
            check=False,
        )  # fmt: skip
        if rendered.returncode != 0:
            raise StartError(f"the edge renderer failed: {rendered.stderr.strip()}")
        if PLAIN_GLOBALS not in rendered.stdout:
            raise StartError("the rendered Caddyfile has no global admin-off line to add the local options to")
        return rendered.stdout.replace(PLAIN_GLOBALS, LOCAL_GLOBALS, 1)
