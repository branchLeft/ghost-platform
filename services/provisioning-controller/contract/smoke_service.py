#!/usr/bin/env python3
"""Start the built provisioning service and answer each of its operations.

Usage: smoke_service.py    (run from services/provisioning-controller after `pnpm run build`)

Starts `node dist/src/service/main.js` the way the README says to, on an
ephemeral port, from files of its own in a scratch directory, and walks the same
journey mock/smoke.py walks over real HTTP. Then it stops the service, starts it
again on the same directory and checks the approval survived and a second
approve is still the same answer. Exit 0 when every answer is the one the
contract says.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from types import ModuleType

PACKAGE = pathlib.Path(__file__).resolve().parent.parent
DEMO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
# Long enough for the service, which refuses a credential under 16 characters.
SMOKE_TENANT_CREDENTIAL = "SMOKE-TENANT-CREDENTIAL-0123456789"
SMOKE_OWNER_CREDENTIAL = "SMOKE-OWNER-CREDENTIAL-0123456789"


def load_walk() -> ModuleType:
    spec = importlib.util.spec_from_file_location("mock_smoke", PACKAGE / "mock" / "smoke.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def start(env: dict[str, str]) -> tuple[subprocess.Popen[str], str]:
    process = subprocess.Popen(
        ["node", "dist/src/service/main.js"],
        cwd=PACKAGE,
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    line = process.stdout.readline()
    found = re.search(r"listening on (\S+):(\d+)", line)
    if found is None:
        process.terminate()
        raise RuntimeError(f"the service did not start: {line!r}")
    return process, f"http://127.0.0.1:{found.group(2)}"


def main() -> int:
    walker = load_walk()
    walker.TENANT_CREDENTIAL = SMOKE_TENANT_CREDENTIAL
    walker.OWNER_CREDENTIAL = SMOKE_OWNER_CREDENTIAL
    problems: list[str] = []
    with tempfile.TemporaryDirectory() as scratch:
        root = pathlib.Path(scratch)
        (root / "owner").write_text(SMOKE_OWNER_CREDENTIAL + "\n")
        (root / "tenants").write_text(f"{walker.TENANT}={SMOKE_TENANT_CREDENTIAL}\n")
        register = root / "demos.json"
        register.write_text(
            json.dumps(
                {
                    "demos": [
                        {
                            "tenantId": walker.TENANT,
                            "demoId": DEMO,
                            "address": "demo.example.test",
                            "state": "LIVE",
                            "expiresAt": "2030-01-01T00:00:00.000Z",
                        }
                    ]
                }
            )
        )
        register.chmod(0o644)
        env = {
            **os.environ,
            "PORT": "0",
            "PROVISIONING_OWNER_CREDENTIAL_FILE": str(root / "owner"),
            "PROVISIONING_TENANT_CREDENTIALS_FILE": str(root / "tenants"),
            "PROVISIONING_DEMOS_FILE": str(register),
            "PROVISIONING_STATE_DIR": str(root / "state"),
        }
        process, base = start(env)
        try:
            # The real service does not finish provisioning on approve: the tenant is
            # essentials and still provisioning, which is all the shared walk asserts.
            problems += walker.walk(base)
            status, _ = walker.call(base, "GET", "/healthz", None)
            if status != 200:
                problems.append(f"/healthz: expected 200, got {status}")
            tenant = ("X-Tenant-Credential", SMOKE_TENANT_CREDENTIAL)
            _, site = walker.call(base, "GET", f"/tenants/{walker.TENANT}", tenant)
        finally:
            process.terminate()
            process.wait(timeout=10)
        again, base = start(env)
        try:
            _, kept = walker.call(base, "GET", f"/tenants/{walker.TENANT}", tenant)
            if kept != site or kept.get("state") != "provisioning":
                problems.append("the approved tenant did not survive a restart")
            _, queue = walker.call(
                base, "GET", "/promotion-requests", ("X-Owner-Credential", SMOKE_OWNER_CREDENTIAL)
            )
            items = queue.get("items") if isinstance(queue, dict) else None
            if not isinstance(items, list) or not items:
                problems.append("the approval queue was empty after a restart")
            else:
                status, first = walker.call(
                    base,
                    "POST",
                    f"/promotion-requests/{items[0]['request_id']}/approve",
                    ("X-Owner-Credential", SMOKE_OWNER_CREDENTIAL),
                )
                if status != 200 or first["state"] != "approved":
                    problems.append("an approved request was not still approved after a restart")
        finally:
            again.terminate()
            again.wait(timeout=10)
    for problem in problems:
        print(f"::error::{problem}")
    if problems:
        return 1
    print("the service answered every operation as the contract says and kept its state")
    return 0


if __name__ == "__main__":
    sys.exit(main())
