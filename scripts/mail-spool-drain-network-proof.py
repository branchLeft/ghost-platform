#!/usr/bin/env python3
"""Prove, against a real Docker daemon, the two drain-network facts the mail
spool depends on, with the rendered Compose file and the fixed ipam pool.

1. `docker compose config` accepts the rendered spool file (static ipam and
   the drain service's fixed ipv4_address) under a dummy token.
2. A drain network that exists WITHOUT a fixed pool is recreated, with the
   fixed pool, cleanly: the old network is removed, the new one reports
   exactly the fixed subnet and gateway and no extra pool keys.

Usage: mail-spool-drain-network-proof.py <rendered-compose-file> <network-name>
       <subnet> <gateway> <bridge-name>

Exit 0 when both hold; a non-zero exit names the step that failed.
Needs the docker CLI and a running daemon. Never touches a host: CI only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Sequence


def run(argv: Sequence[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run one command from an argv list. Never a shell."""
    return subprocess.run(list(argv), capture_output=True, text=True, check=False, env=env)


def fail(step: str, detail: str) -> int:
    sys.stderr.write(f"FAIL {step}: {detail}\n")
    return 1


def compose_accepts(compose_file: str) -> str | None:
    """Return None when `docker compose config` accepts the file, else the error."""
    env = dict(os.environ)
    env.setdefault("SHIM_DRAIN_TOKEN", "ci-dummy-token-not-a-secret")
    done = run(["docker", "compose", "-f", compose_file, "config", "--quiet"], env=env)
    if done.returncode != 0:
        return done.stderr.strip() or f"exit {done.returncode}"
    return None


def pool_of(network: str) -> dict[str, object] | None:
    """The network's ipam pool as Docker reports it, or None when it has none."""
    done = run(["docker", "network", "inspect", network])
    if done.returncode != 0:
        return None
    body = json.loads(done.stdout)
    configs = body[0].get("IPAM", {}).get("Config") or []
    return configs[0] if configs else None


def main(argv: Sequence[str]) -> int:
    if len(argv) != 6:
        sys.stderr.write(
            "usage: mail-spool-drain-network-proof.py <compose-file> <network> <subnet> <gateway> <bridge>\n"
        )
        return 2
    compose_file, network, subnet, gateway, bridge = argv[1:]

    # Step 1: real Compose acceptance of the static ipam and the fixed address.
    error = compose_accepts(compose_file)
    if error is not None:
        return fail("compose-accepts", error)
    print("PASS compose-accepts: docker compose config accepts the rendered file")

    # Step 2: an existing drain network with NO fixed pool, as before this change.
    run(["docker", "network", "rm", network])
    made = run(["docker", "network", "create", "--driver", "bridge", network])
    if made.returncode != 0:
        return fail("create-pool-less", made.stderr.strip())
    if pool_of(network) is not None:
        return fail("create-pool-less", "a network created with no pool reports one")
    print("PASS create-pool-less: the old drain network exists with no fixed pool")

    # Step 3: recreate it cleanly with the fixed pool and the host bridge name.
    removed = run(["docker", "network", "rm", network])
    if removed.returncode != 0:
        return fail("recreate-remove", removed.stderr.strip())
    recreated = run(
        [
            "docker",
            "network",
            "create",
            "--driver",
            "bridge",
            "--subnet",
            subnet,
            "--gateway",
            gateway,
            "--opt",
            f"com.docker.network.bridge.name={bridge}",
            "--opt",
            "com.docker.network.bridge.enable_ip_masquerade=false",
            network,
        ]
    )
    if recreated.returncode != 0:
        return fail("recreate-create", recreated.stderr.strip())

    # Step 4: the recreated pool is exactly the fixed subnet and gateway.
    pool = pool_of(network)
    if pool is None:
        return fail("recreate-pool", "the recreated network reports no pool")
    if set(pool) - {"Subnet", "Gateway"}:
        return fail("recreate-pool", f"extra pool keys reported: {sorted(set(pool) - {'Subnet', 'Gateway'})}")
    if pool.get("Subnet") != subnet or pool.get("Gateway") != gateway:
        return fail("recreate-pool", f"pool is {pool}, want subnet {subnet} gateway {gateway}")
    print(f"PASS recreate-pool: {network} recreated with exactly {subnet} via {gateway}")

    run(["docker", "network", "rm", network])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
