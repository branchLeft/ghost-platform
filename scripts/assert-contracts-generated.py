#!/usr/bin/env python3
"""Assert each committed generated tree is what Speckify generates from its spec.

Usage: assert-contracts-generated.py [--write] [--contract NAME] <speckify-out-dir>
       assert-contracts-generated.py --self-test

`<speckify-out-dir>` is the directory `speckify build` wrote (`.speckify/out`);
each contract's source is `<out>/<name>/typescript/src`. With no `--contract`
every contract in CONTRACTS is checked (or, with `--write`, rewritten).

Exit 0 when every committed tree matches, 1 on any difference or when
speckify.yaml and CONTRACTS name different contracts, 2 on usage error.
See scripts/assert-contracts-generated.md#why-this-check-exists.
"""

from __future__ import annotations

import pathlib
import re
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent

# One row per contract in speckify.yaml: its name there, and where its
# generated sources are committed. A contract added to speckify.yaml without a
# row here (or a row without a contract) is itself reported, so a new tree
# cannot be generated and left unchecked.
CONTRACTS: dict[str, pathlib.Path] = {
    "broker-api": REPO / "services" / "broker" / "src" / "generated",
    "provisioning-api": REPO / "services" / "provisioning-controller" / "src" / "generated",
}

SPECKIFY_CONFIG = REPO / "speckify.yaml"

# Two lines, because the generated sources are written for a consumer that
# compiles them in a package of their own, and a consuming package's compiler
# options (unused locals, no DOM lib) are stricter than that package's.
HEADER = (
    "// @ts-nocheck\n"
    "// Speckify output, committed as generated and never edited by hand.\n"
)


def _files(root: pathlib.Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def differences(source: pathlib.Path, committed: pathlib.Path) -> list[str]:
    """Every way `committed` disagrees with HEADER + each file of `source`."""
    expected = {
        name: HEADER.encode("utf-8") + data for name, data in _files(source).items()
    }
    actual = _files(committed) if committed.is_dir() else {}
    problems: list[str] = []
    for name in sorted(expected.keys() - actual.keys()):
        problems.append(f"missing from the committed tree: {name}")
    for name in sorted(actual.keys() - expected.keys()):
        problems.append(f"in the committed tree but not generated: {name}")
    for name in sorted(expected.keys() & actual.keys()):
        if expected[name] != actual[name]:
            problems.append(f"differs from what Speckify generates: {name}")
    return problems


def write(source: pathlib.Path, committed: pathlib.Path) -> None:
    for old in sorted(committed.rglob("*")) if committed.is_dir() else []:
        if old.is_file():
            old.unlink()
    for name, data in _files(source).items():
        target = committed / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(HEADER.encode("utf-8") + data)


def configured_contracts(config_text: str) -> list[str]:
    """The contract names under `contracts:` in a speckify.yaml, in order."""
    names: list[str] = []
    in_contracts = False
    for line in config_text.splitlines():
        if re.match(r"^contracts:\s*$", line):
            in_contracts = True
            continue
        if in_contracts and re.match(r"^\S", line) and not line.startswith("#"):
            in_contracts = False
        found = re.match(r"^  - name:\s*(\S+)\s*$", line)
        if in_contracts and found:
            names.append(found.group(1))
    return names


def registry_problems(config_text: str, registered: list[str]) -> list[str]:
    """Where speckify.yaml and the CONTRACTS table name different contracts."""
    configured = configured_contracts(config_text)
    problems: list[str] = []
    for name in sorted(set(configured) - set(registered)):
        problems.append(
            f"speckify.yaml names contract {name}, which has no committed tree "
            "registered in scripts/assert-contracts-generated.py"
        )
    for name in sorted(set(registered) - set(configured)):
        problems.append(
            f"scripts/assert-contracts-generated.py registers {name}, "
            "which is not in speckify.yaml"
        )
    return problems


def self_test() -> int:
    """Both directions: a clean tree passes, and each kind of drift is found."""
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        source = root / "source"
        committed = root / "committed"
        (source / "core").mkdir(parents=True)
        (source / "server.ts").write_text("export const a = 1;\n")
        (source / "core" / "utils.ts").write_text("export const b = 2;\n")

        write(source, committed)
        checks: list[tuple[str, bool]] = []
        checks.append(("a freshly written tree has no differences", differences(source, committed) == []))

        (committed / "server.ts").write_text(HEADER + "export const a = 9;\n")
        found = differences(source, committed)
        checks.append(("an edited file is reported", any("server.ts" in p for p in found)))
        write(source, committed)

        (committed / "core" / "utils.ts").unlink()
        found = differences(source, committed)
        checks.append(("a missing file is reported", any("missing" in p and "utils.ts" in p for p in found)))
        write(source, committed)

        (committed / "stray.ts").write_text(HEADER)
        found = differences(source, committed)
        checks.append(("an extra file is reported", any("not generated" in p and "stray.ts" in p for p in found)))
        write(source, committed)

        (committed / "server.ts").write_text("export const a = 1;\n")
        found = differences(source, committed)
        checks.append(("a file without the header is reported", any("server.ts" in p for p in found)))

        checks.append(("the empty committed directory is reported as all missing", len(differences(source, root / "absent")) == 2))

    config = (
        "# comment\n"
        "contracts:\n"
        "  - name: one-api\n"
        "    spec: ./one.yaml\n"
        "  - name: two-api\n"
        "    spec: ./two.yaml\n"
        "\n"
        "publish:\n"
        "  - name: not-a-contract\n"
    )
    checks.append(("contract names are read from the contracts block only", configured_contracts(config) == ["one-api", "two-api"]))
    checks.append(("a matching registry has no problems", registry_problems(config, ["two-api", "one-api"]) == []))
    checks.append(("a contract with no registered tree is reported", any("two-api" in p for p in registry_problems(config, ["one-api"]))))
    checks.append(("a registered tree with no contract is reported", any("three-api" in p for p in registry_problems(config, ["one-api", "two-api", "three-api"]))))
    checks.append(("the real registry names every contract in speckify.yaml", registry_problems(SPECKIFY_CONFIG.read_text(), list(CONTRACTS)) == []))

    failed = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    return 1 if failed else 0


def parse_args(argv: list[str]) -> tuple[bool, str | None, pathlib.Path] | None:
    """(write, only contract, out dir), or None when the arguments are wrong."""
    do_write = False
    only: str | None = None
    rest: list[str] = []
    args = list(argv)
    while args:
        arg = args.pop(0)
        if arg == "--write":
            do_write = True
        elif arg == "--contract":
            if not args:
                return None
            only = args.pop(0)
        else:
            rest.append(arg)
    if len(rest) != 1 or (only is not None and only not in CONTRACTS):
        return None
    return do_write, only, pathlib.Path(rest[0])


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    parsed = parse_args(argv)
    if parsed is None:
        print(__doc__, file=sys.stderr)
        return 2
    do_write, only, out_dir = parsed
    if not out_dir.is_dir():
        print(f"not a directory: {out_dir}", file=sys.stderr)
        return 2

    names = [only] if only is not None else list(CONTRACTS)
    failed = False
    if only is None:
        for problem in registry_problems(SPECKIFY_CONFIG.read_text(), list(CONTRACTS)):
            print(f"::error::{problem}")
            failed = True
    for name in names:
        source = out_dir / name / "typescript" / "src"
        committed = CONTRACTS[name]
        shown = committed.relative_to(REPO)
        if not source.is_dir():
            print(f"::error::{name}: Speckify wrote no {source}")
            failed = True
            continue
        if do_write:
            write(source, committed)
            print(f"wrote {len(_files(source))} files to {shown}")
            continue
        problems = differences(source, committed)
        for problem in problems:
            print(f"::error::{name}: {problem}")
        if problems:
            print(
                f"Regenerate with: speckify build, then python3 "
                f"scripts/assert-contracts-generated.py --write --contract {name} .speckify/out"
            )
            failed = True
        else:
            print(f"{shown} matches what Speckify generates from the {name} spec")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
