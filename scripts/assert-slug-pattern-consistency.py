#!/usr/bin/env python3
"""Assert every in-repo copy of the tenant-slug charset/length rule agrees.

Usage:
    assert-slug-pattern-consistency.py
    assert-slug-pattern-consistency.py --self-test

The same charset-and-length rule is written four times in this repository,
because the tenant slug becomes a Compose project name, a systemd instance
name, a MySQL identifier, a Docker volume name and an S3-compatible bucket
name, and each of those is checked by code that runs on a different host or
from a different workstation, with no shared import between them:

    infra/tenant/naming.ts                                  (Pulumi, TS)
    db/provision/naming.py                                  (db1, hand-run)
    infra/provisioning/scripts/render-media-bucket-policy.py (operator workstation)
    app/provision/provision_tenant_volume.py                (app1, hand-run)

`branchLeft/workspace#681` found that a fifth copy, in the sibling template
repository, had drifted to a looser pattern than these four -- and that
nothing had ever verified these four agreed with each other in the first
place; the third of them was found to match only "by luck", per a reviewer
checking it by hand after the other two changed. This script is that missing
verification, run on every push.

It does not (and cannot, without a JS runtime it would then have to trust)
reach into `branchLeft/ghost-platform-tenant-template`, whose own CI instead
executes this repository's *published* `@branchleft/ghost-platform-tenant`
package and checks its behaviour against that template's copy directly.

`db/provision/naming.py` is deliberately not checked against RESERVED_PROBES
below: by the time DB provisioning ever runs against a slug, `infra/tenant`'s
`GhostTenant` component has already refused a reserved one during `pulumi
up`, so that module was never given the reserved-name check. Excluding it
from that one probe set is a recorded scope decision, not an oversight this
script failed to catch -- conflating it with a real charset divergence would
make this gate cry wolf on every future intentional layering choice.

Exit 0 when every copy agrees on every probe it participates in, 1 on any
disagreement (or if `infra/tenant/naming.ts` cannot be executed at all), 2 on
usage error.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
import types

REPO = pathlib.Path(__file__).resolve().parent.parent

# (slug, expected well-formed). None of these is a reserved name, so every
# copy that implements the charset-and-length rule -- whether or not it also
# layers a reserved-name refusal on top -- is directly comparable on all of
# them.
CHARSET_LENGTH_PROBES: list[tuple[str, bool]] = [
    ("", False),
    ("-blog", False),
    ("blog-", False),
    ("Blog", False),
    ("blög", False),
    ("1blog", False),
    ("blog_one", False),
    ("blog one", False),
    ("blog/../website", False),
    ("a", True),
    ("ab", True),
    ("blog", True),
    ("blog--co", True),
    ("acme-blog", True),
    ("a" * 26, True),
    ("a" * 27, False),
]

# Every stack name an app host already runs under. Checked against the copies
# that implement a reserved-name refusal (everything except naming.py; see
# the module docstring).
RESERVED_PROBES = ["website", "edge", "db", "monitoring"]

NAMING_TS = REPO / "infra" / "tenant" / "naming.ts"


def _load(relpath: str) -> types.ModuleType:
    path = REPO / relpath
    # `render-media-bucket-policy.py` does a plain `from bucketpolicy import
    # ...`, resolved only because the two files sit in the same directory --
    # true when it is invoked as a script, not when it is loaded by path like
    # this. Its directory has to go on `sys.path` for that sibling import to
    # resolve the same way here.
    directory = str(path.parent)
    added = directory not in sys.path
    if added:
        sys.path.insert(0, directory)
    try:
        spec = importlib.util.spec_from_file_location(path.stem, path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if added:
            sys.path.remove(directory)


def _accepts(fn, slug: str) -> bool:
    try:
        fn(slug)
        return True
    except Exception:
        return False


def naming_py_checker() -> object:
    naming = _load("db/provision/naming.py")
    return lambda slug: _accepts(naming.validate_tenant_name, slug)


def media_bucket_checker() -> object:
    module = _load("infra/provisioning/scripts/render-media-bucket-policy.py")
    return lambda slug: _accepts(module.media_bucket_name, slug)


def provision_volume_checker() -> object:
    module = _load("app/provision/provision_tenant_volume.py")
    return lambda slug: _accepts(module.validate_slug, slug)


# name -> (checker factory, participates in the RESERVED_PROBES comparison)
COPIES: dict[str, tuple[object, bool]] = {
    "db/provision/naming.py": (naming_py_checker, False),
    "infra/provisioning/scripts/render-media-bucket-policy.py": (media_bucket_checker, True),
    "app/provision/provision_tenant_volume.py": (provision_volume_checker, True),
}


def naming_ts_batch(slugs: list[str], node_bin: str = "node", naming_ts: pathlib.Path = NAMING_TS) -> list[bool]:
    """Run every slug through the real `validateTenantSlug` from TS source.

    Executed rather than parsed: an earlier draft of a sibling check in the
    template repo parsed a *compiled* regex out of `dist/*.js` and passed
    against the wrong value, because the compiled output's hoisted
    initialiser matched the parser before the real assignment did. Running
    the TS source directly, via Node's type-stripping, has no such
    intermediate representation to parse incorrectly.
    """
    script = (
        f"import * as m from '{naming_ts.as_posix()}';"
        "const probes = JSON.parse(process.argv[1]);"
        "const out = probes.map((s) => {"
        "  try { m.validateTenantSlug(s); return true; }"
        "  catch (e) { return false; }"
        "});"
        "process.stdout.write(JSON.stringify(out));"
    )
    result = subprocess.run(
        [node_bin, "--experimental-strip-types", "--input-type=module", "-e", script, "--", json.dumps(slugs)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


def find_disagreements(
    copies: dict[str, tuple[object, bool]],
    ts_batch,
) -> list[str]:
    """The comparator, independent of which real files it is pointed at.

    Kept separate from `run_checks` so `--self-test` can hand it a checker
    that is deliberately wrong and prove this gate would report it.
    """
    failures: list[str] = []
    checkers = {name: factory() for name, (factory, _reserved) in copies.items()}

    charset_slugs = [slug for slug, _ in CHARSET_LENGTH_PROBES]
    try:
        ts_results = dict(zip(charset_slugs, ts_batch(charset_slugs)))
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        return [f"could not execute infra/tenant/naming.ts via node: {error}"]

    for slug, expected in CHARSET_LENGTH_PROBES:
        ts_actual = ts_results[slug]
        if ts_actual != expected:
            failures.append(
                f"infra/tenant/naming.ts {'accepts' if ts_actual else 'rejects'} {slug!r}; "
                f"expected {'accept' if expected else 'reject'}"
            )
        for name, checker in checkers.items():
            actual = checker(slug)
            if actual != expected:
                failures.append(
                    f"{name} {'accepts' if actual else 'rejects'} {slug!r}; expected "
                    f"{'accept' if expected else 'reject'} (charset/length rule)"
                )

    try:
        ts_reserved = dict(zip(RESERVED_PROBES, ts_batch(RESERVED_PROBES)))
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        return failures + [f"could not execute infra/tenant/naming.ts via node: {error}"]

    for slug in RESERVED_PROBES:
        if ts_reserved[slug]:
            failures.append(f"infra/tenant/naming.ts accepts reserved slug {slug!r}")
        for name, (_factory, reserved) in copies.items():
            if not reserved:
                continue
            if checkers[name](slug):
                failures.append(f"{name} accepts reserved slug {slug!r}")

    return failures


def run_checks(node_bin: str = "node") -> list[str]:
    return find_disagreements(COPIES, lambda slugs: naming_ts_batch(slugs, node_bin))


def self_test() -> int:
    failed = False

    # A checker set that agrees with `naming.ts` on everything must report no
    # disagreements.
    def ts_stub(slugs: list[str]) -> list[bool]:
        return [_accepts(_reference_validate, s) for s in slugs]

    agreeing = {
        "agreeing-copy": (lambda: (lambda s: _accepts(_reference_validate, s)), True),
    }
    clean = find_disagreements(agreeing, ts_stub)
    ok = clean == []
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'}: an agreeing copy reports no disagreement -> {clean!r}")

    # A copy that has drifted loose -- accepting a trailing hyphen, exactly
    # `branchLeft/workspace#681`'s finding -- must be caught.
    def loose_validate(slug: str) -> None:
        import re

        if not re.match(r"\A[a-z][a-z0-9-]*\Z", slug):
            raise ValueError(slug)
        if len(slug) > 26:
            raise ValueError(slug)

    drifted = {
        "drifted-copy": (lambda: (lambda s: _accepts(loose_validate, s)), True),
    }
    found = find_disagreements(drifted, ts_stub)
    ok = any("blog-" in f and "drifted-copy" in f for f in found)
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'}: a trailing-hyphen drift is caught -> {found!r}")

    # A copy that silently accepts a reserved name must be caught too, and
    # independently of the charset probes above.
    def unreserved_validate(slug: str) -> None:
        _reference_validate(slug, skip_reserved=True)

    unreserved = {
        "unreserved-copy": (lambda: (lambda s: _accepts(unreserved_validate, s)), True),
    }
    found = find_disagreements(unreserved, ts_stub)
    ok = any("website" in f and "unreserved-copy" in f for f in found)
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'}: an unenforced reserved name is caught -> {found!r}")

    if failed:
        print("\nThis gate no longer behaves as written. It would report success")
        print("against a copy that has drifted from the other three.")
    return 1 if failed else 0


def _reference_validate(slug: str, skip_reserved: bool = False) -> None:
    import re

    if not re.match(r"\A[a-z]([a-z0-9-]*[a-z0-9])?\Z", slug):
        raise ValueError(slug)
    if len(slug) > 26:
        raise ValueError(slug)
    if not skip_reserved and slug in RESERVED_PROBES:
        raise ValueError(slug)


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        return self_test()
    if len(argv) != 1:
        print(__doc__)
        return 2

    failures = run_checks()
    if failures:
        for failure in failures:
            print(f"::error::{failure}")
        print(
            "\n::error::the tenant-slug charset/length rule has drifted between copies in "
            "this repository. A slug valid in one place and not another produces a tenant "
            "that half-exists."
        )
        return 1

    print(
        f"OK: infra/tenant/naming.ts and {len(COPIES)} in-repo copies agree on "
        f"{len(CHARSET_LENGTH_PROBES)} charset/length probes and {len(RESERVED_PROBES)} "
        "reserved-name probes."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
