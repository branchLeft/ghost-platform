#!/usr/bin/env python3
"""Keep the generated tenant-name blocks in step with registers/tenant-names.json.

Usage: sync-tenant-name-register.py [--check | --self-test]

With no argument, rewrites the block between the BEGIN/END GENERATED markers
in each target file. `--check` rewrites nothing and exits 1 if any target
differs from what the register would produce. `--self-test` proves the check
catches drift. Exit 2 on a usage error or an unreadable register.
See scripts/sync-tenant-name-register.md#why-this-script-exists.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
REGISTER = REPO / "registers" / "tenant-names.json"
TARGETS = (
    REPO / "infra" / "tenant" / "naming.ts",
    REPO / "render-core" / "src" / "naming.ts",
)

BEGIN = (
    "// BEGIN GENERATED FROM registers/tenant-names.json -- edit the register, "
    "then run scripts/sync-tenant-name-register.py"
)
END = "// END GENERATED FROM registers/tenant-names.json"

NAME_PATTERN = re.compile(r"\A[a-z]([a-z0-9-]*[a-z0-9])?\Z")
REPO_PATTERN = re.compile(r"\A[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
KINDS = ("infrastructure", "tenant")


class RegisterError(Exception):
    pass


def load_register(path: pathlib.Path = REGISTER) -> list[dict[str, str]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RegisterError(f"cannot read {path}: {error}") from error
    return validate_register(data)


def validate_register(data: object) -> list[dict[str, str]]:
    if not isinstance(data, dict) or data.get("version") != 1:
        raise RegisterError('the register must be an object with "version": 1')
    names = data.get("names")
    if not isinstance(names, list) or not names:
        raise RegisterError('the register needs a non-empty "names" list')
    seen: set[str] = set()
    for entry in names:
        if not isinstance(entry, dict):
            raise RegisterError(f"entry is not an object: {entry!r}")
        name, kind, repo = entry.get("name"), entry.get("kind"), entry.get("repo")
        if not isinstance(name, str) or not NAME_PATTERN.match(name):
            raise RegisterError(f"entry name is not a valid slug: {name!r}")
        if name in seen:
            raise RegisterError(f"duplicate name: {name!r}")
        seen.add(name)
        if kind not in KINDS:
            raise RegisterError(f"{name}: kind must be one of {KINDS}, got {kind!r}")
        if kind == "tenant" and not (isinstance(repo, str) and REPO_PATTERN.match(repo)):
            raise RegisterError(f"{name}: a tenant entry needs a repo as org/name, got {repo!r}")
        if kind == "infrastructure" and repo is not None:
            raise RegisterError(f"{name}: an infrastructure entry must not carry a repo")
        extra = set(entry) - {"name", "kind", "repo"}
        if extra:
            raise RegisterError(f"{name}: unknown keys {sorted(extra)}")
    return names


def render_block(names: list[dict[str, str]]) -> str:
    lines = [
        BEGIN,
        "export type RegisteredName =",
        "  | { readonly name: string; readonly kind: 'infrastructure' }",
        "  | { readonly name: string; readonly kind: 'tenant'; readonly repo: string };",
        "",
        "export const TENANT_NAME_REGISTER: readonly RegisteredName[] = [",
    ]
    for entry in names:
        if entry["kind"] == "tenant":
            lines.append(
                f"  {{ name: '{entry['name']}', kind: 'tenant', repo: '{entry['repo']}' }},"
            )
        else:
            lines.append(f"  {{ name: '{entry['name']}', kind: 'infrastructure' }},")
    lines += ["];", END]
    return "\n".join(lines)


def replace_block(source: str, block: str) -> str:
    start = source.find(BEGIN)
    end = source.find(END)
    if start == -1 or end == -1 or end < start:
        raise RegisterError("the BEGIN/END GENERATED markers are missing or out of order")
    return source[:start] + block + source[end + len(END) :]


def drifted_targets(
    names: list[dict[str, str]], targets: tuple[pathlib.Path, ...] = TARGETS, write: bool = False
) -> list[str]:
    block = render_block(names)
    drifted = []
    for target in targets:
        source = target.read_text(encoding="utf-8")
        updated = replace_block(source, block)
        if updated != source:
            drifted.append(str(target.relative_to(REPO)) if target.is_relative_to(REPO) else str(target))
            if write:
                target.write_text(updated, encoding="utf-8")
    return drifted


def self_test() -> int:
    import tempfile

    names = validate_register(
        {
            "version": 1,
            "names": [
                {"name": "edge", "kind": "infrastructure"},
                {"name": "blog", "kind": "tenant", "repo": "org/repo"},
            ],
        }
    )
    failed = False
    with tempfile.TemporaryDirectory(prefix="sync-register-") as directory:
        target = pathlib.Path(directory) / "naming.ts"
        target.write_text(f"before\n{BEGIN}\nstale\n{END}\nafter\n", encoding="utf-8")
        found = drifted_targets(names, (target,))
        ok = found == [str(target)]
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: a stale block is reported as drift -> {found!r}")

        drifted_targets(names, (target,), write=True)
        found = drifted_targets(names, (target,))
        text = target.read_text(encoding="utf-8")
        ok = found == [] and text.startswith("before\n") and text.endswith("\nafter\n")
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: a rewritten block is clean and keeps its surroundings")

        target.write_text(text.replace("'edge'", "'edgx'"), encoding="utf-8")
        found = drifted_targets(names, (target,))
        ok = found == [str(target)]
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: a hand edit inside the block is reported -> {found!r}")

    for label, bad in (
        ("a tenant entry with no repo", [{"name": "x1", "kind": "tenant"}]),
        ("a duplicate name", [{"name": "x1", "kind": "infrastructure"}] * 2),
        ("an infrastructure entry with a repo", [{"name": "x1", "kind": "infrastructure", "repo": "a/b"}]),
    ):
        try:
            validate_register({"version": 1, "names": bad})
            ok = False
        except RegisterError:
            ok = True
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: the register refuses {label}")
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        return self_test()
    if argv[1:] not in ([], ["--check"]):
        print(__doc__)
        return 2
    try:
        names = load_register()
        check = argv[1:] == ["--check"]
        drifted = drifted_targets(names, write=not check)
    except (RegisterError, OSError) as error:
        print(f"::error::{error}")
        return 2
    if check and drifted:
        for path in drifted:
            print(f"::error::{path} differs from registers/tenant-names.json")
        print("::error::run scripts/sync-tenant-name-register.py and commit the result.")
        return 1
    if drifted:
        print("rewrote: " + ", ".join(drifted))
    else:
        print(f"OK: {len(TARGETS)} generated blocks match the register ({len(names)} names).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
