#!/usr/bin/env python3
"""Start the built provisioning mock and answer each of its five operations.

Usage: smoke.py            (run from services/provisioning-controller after `pnpm run build`)

Starts `node dist/mock/main.js` the way the README says to, on an ephemeral
port, with test credentials of its own, walks the promotion journey over real
HTTP, and stops it. Exit 0 when every answer is the one the contract says.
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

PACKAGE = pathlib.Path(__file__).resolve().parent.parent
TENANT = "11111111-1111-4111-8111-111111111111"
TENANT_CREDENTIAL = "SMOKE_TENANT_CREDENTIAL"
OWNER_CREDENTIAL = "SMOKE_OWNER_CREDENTIAL"


def call(
    base: str,
    method: str,
    path: str,
    header: tuple[str, str] | None,
    body: dict[str, str] | None = None,
) -> tuple[int, Any]:
    headers = {} if header is None else {header[0]: header[1]}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"null")


def walk(base: str) -> list[str]:
    """Every way an answer differs from the contract; empty when none does."""
    tenant = ("X-Tenant-Credential", TENANT_CREDENTIAL)
    owner = ("X-Owner-Credential", OWNER_CREDENTIAL)
    problems: list[str] = []

    def expect(label: str, got: int, want: int) -> None:
        if got != want:
            problems.append(f"{label}: expected {want}, got {got}")

    status, demo = call(base, "GET", f"/tenants/{TENANT}/demo", tenant)
    expect("getDemo", status, 200)
    status, asked = call(
        base, "POST", f"/tenants/{TENANT}/promotion-requests", tenant, {"tier": "essentials"}
    )
    expect("createPromotionRequest", status, 201)
    request_id = asked["request_id"] if isinstance(asked, dict) else ""
    status, queue = call(base, "GET", "/promotion-requests?state=pending", owner)
    expect("listPromotionRequests", status, 200)
    if not isinstance(queue, dict) or [i["request_id"] for i in queue["items"]] != [request_id]:
        problems.append("listPromotionRequests: the queue is not the one pending request")
    status, _ = call(base, "GET", "/promotion-requests", tenant)
    expect("a tenant credential on the owner list", status, 403)
    status, first = call(base, "POST", f"/promotion-requests/{request_id}/approve", owner)
    expect("approvePromotionRequest", status, 200)
    status, second = call(base, "POST", f"/promotion-requests/{request_id}/approve", owner)
    expect("a second approve", status, 200)
    if first != second:
        problems.append("a second approve did not return the identical body")
    status, site = call(base, "GET", f"/tenants/{TENANT}", tenant)
    expect("getTenant", status, 200)
    if not isinstance(site, dict) or site.get("tier") != "essentials":
        problems.append("getTenant: the tenant is not on the essentials tier after approval")
    if not isinstance(demo, dict) or demo.get("state") != "LIVE":
        problems.append("getDemo: the demo was not LIVE")
    return problems


def main() -> int:
    env = {
        **os.environ,
        "PORT": "0",
        "MOCK_OWNER_CREDENTIAL": OWNER_CREDENTIAL,
        "MOCK_TENANT_CREDENTIALS": f"{TENANT}={TENANT_CREDENTIAL}",
    }
    process = subprocess.Popen(
        ["node", "dist/mock/main.js"],
        cwd=PACKAGE,
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        line = process.stdout.readline()
        found = re.search(r"listening on (http://\S+)", line)
        if found is None:
            print(f"the mock did not start: {line!r}", file=sys.stderr)
            return 1
        problems = walk(found.group(1))
    finally:
        process.terminate()
        process.wait(timeout=10)
    for problem in problems:
        print(f"::error::{problem}")
    if problems:
        return 1
    print("the mock answered all five operations as the contract says")
    return 0


if __name__ == "__main__":
    sys.exit(main())
