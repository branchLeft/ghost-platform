#!/usr/bin/env python3
"""Assert services/broker/src/generated is what Speckify generates from the spec.

Usage: assert-broker-contract-generated.py [--write] <speckify-src-dir>
       assert-broker-contract-generated.py --self-test

Exit 0 when the committed tree matches, 1 on any difference, 2 on usage error.
See scripts/assert-broker-contract-generated.md#why-this-check-exists.
"""

from __future__ import annotations

import pathlib
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
GENERATED = REPO / "services" / "broker" / "src" / "generated"

# Two lines, because the generated sources are written for a consumer that
# compiles them in a package of their own, and the broker's compiler options
# (unused locals, no DOM lib) are stricter than that package's.
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

    failed = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return self_test()
    do_write = argv[:1] == ["--write"]
    rest = argv[1:] if do_write else argv
    if len(rest) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    source = pathlib.Path(rest[0])
    if not source.is_dir():
        print(f"not a directory: {source}", file=sys.stderr)
        return 2
    if do_write:
        write(source, GENERATED)
        print(f"wrote {len(_files(source))} files to {GENERATED.relative_to(REPO)}")
        return 0
    problems = differences(source, GENERATED)
    for problem in problems:
        print(f"::error::{problem}")
    if problems:
        print(
            "Regenerate with: speckify build, then "
            "python3 scripts/assert-broker-contract-generated.py --write "
            ".speckify/out/broker-api/typescript/src"
        )
        return 1
    print(f"{GENERATED.relative_to(REPO)} matches what Speckify generates from the spec")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
