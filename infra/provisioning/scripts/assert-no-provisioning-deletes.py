#!/usr/bin/env python3
"""Fail if a plan applied by the provisioning identity would destroy anything.

The plan matcher mirrors `infra/platform/scripts/assert-no-platform-deletes.py`
(same Pulumi CLI, same `--json` shape, same fail-closed substring test on the
op name). What differs is the protected set, and the difference is the whole
point of this script existing.

**The protected set is the platform's, not the tenant's.** This gate runs on
applies made by the tenant-provisioning identity, which holds project-wide
service-account, project-IAM and workload-identity-pool administration. The
tenant-side guard would not catch a step against platform infrastructure: its
protected set is tenant-derived names plus that repo's own CI identity, and
`ghost-platform-db` appears nowhere in it -- correctly, because a tenant
program never declares the instance. So the platform names are listed here and
their coverage is verified against the platform program's sources, which means
renaming a resource over there fails this gate rather than silently emptying
it.

The failure being guarded is not malice. It is a future refactor that turns an
immutable field into a forced replacement, resolved by the engine against a
shared resource, arriving inside an otherwise routine provisioning run that a
reviewer approves because the summary looks like onboarding. That is why the
op test covers replacements and not only outright deletes.

**What this cannot do, stated because the gap matters more here than it does
for the platform gate.** A plan guard constrains Pulumi. It does not constrain
the identity. Every permission the provisioning identity holds is reachable by
a direct API call from any step in the same job, and no preflight against a
preview can see that. The controls that do bound it are the ones that are
structural: the roles it does not hold (notably no
`cloudsql.instances.{delete,update}` -- see the runbook's P4), and the fact
that nothing on a routine code path can assume it at all.

Usage:
    assert-no-provisioning-deletes.py --tenant <name> <preview-json-file>
    assert-no-provisioning-deletes.py --self-test
    assert-no-provisioning-deletes.py --verify-coverage <platform-dir> <provisioning-dir>

Exit 0 clean, 1 if a protected resource would be destroyed or any input could
not be read, 2 on usage error.
"""

import json
import pathlib
import re
import sys

# Declared by infra/platform. This program must never contain a step against
# any of them; if it ever does, that is the refactor this gate exists for.
PLATFORM_PROTECTED = {
    "ghost-platform-db",
    "ghost-platform-media",
    "ghost-platform-tenant-repo",
    "ghost-platform-gha-pool",
    "ghost-platform-gha-provider",
    "ghost-platform-deployer-sa",
    "ghost-platform-gha-can-impersonate-deployer",
    "ghost-platform-media-deployer-manage",
}

# Declared by this program, named `<tenant>-<suffix>`. Destroying any of them
# locks a live tenant's CI out of the project with no way back through CI --
# and a deleted Workload Identity pool is soft-deleted, its ID unusable for 30
# days, so "re-run the apply" does not recover it. The state bucket is worse
# again: it is the only record of what that tenant's infrastructure is.
TENANT_SUFFIXES = {
    "-pulumi-state",
    "-deployer-sa",
    "-gha-pool",
    "-gha-provider",
    "-gha-can-impersonate-deployer",
}

DESTRUCTIVE_SUBSTRINGS = ("delete", "replace")


def protected_names(tenant: str) -> set[str]:
    return PLATFORM_PROTECTED | {f"{tenant}{suffix}" for suffix in TENANT_SUFFIXES}


def destructive_steps(plan: dict, tenant: str) -> list[tuple[str, str]]:
    """Return (name, op) for every protected resource this plan would destroy.

    Raises ValueError rather than returning [] on a plan it cannot parse: "I
    found no steps" and "there are no destructive steps" must not share an
    exit code.
    """
    steps = plan.get("steps")
    if not isinstance(steps, list):
        raise ValueError("no 'steps' array in the preview JSON")

    guarded = protected_names(tenant)
    found: list[tuple[str, str]] = []
    for step in steps:
        if not isinstance(step, dict):
            raise ValueError(f"malformed step entry: {step!r}")
        op = step.get("op")
        urn = step.get("urn")
        if not isinstance(op, str) or not isinstance(urn, str):
            raise ValueError(f"step missing op/urn: {step!r}")
        if not any(word in op for word in DESTRUCTIVE_SUBSTRINGS):
            continue
        name = urn.rsplit("::", 1)[-1]
        if name in guarded:
            found.append((name, op))
    return found


def _declaration_pattern_literal(name: str) -> re.Pattern[str]:
    """Match `new <Ctor>('<name>'` -- a declaration, not a mention.

    Anchored to the constructor call because a bare-string search reports a
    false pass: a renamed logical id often leaves the old text present as a
    comment or an unrelated constant.
    """
    return re.compile(rf"""\bnew\s+[\w.]+\(\s*['"]{re.escape(name)}['"]""")


def _declaration_pattern_suffix(suffix: str) -> re.Pattern[str]:
    """Match ``new <Ctor>(`${tenantName}<suffix>` `` in this program."""
    return re.compile(rf"""\bnew\s+[\w.]+\(\s*`\$\{{[\w.]*tenantName\}}{re.escape(suffix)}`""")


_T = "acme"
_URN_DB = (
    "urn:pulumi:acme::branchleft-ghost-provisioning::"
    "gcp:sql/databaseInstance:DatabaseInstance::ghost-platform-db"
)
_URN_BUCKET = (
    "urn:pulumi:acme::branchleft-ghost-provisioning::"
    f"gcp:storage/bucket:Bucket::{_T}-pulumi-state"
)
_URN_POOL = (
    "urn:pulumi:acme::branchleft-ghost-provisioning::"
    f"gcp:iam/workloadIdentityPool:WorkloadIdentityPool::{_T}-gha-pool"
)
_URN_UNPROTECTED = (
    "urn:pulumi:acme::branchleft-ghost-provisioning::"
    f"gcp:projects/iAMMember:IAMMember::{_T}-deployer-run-developer"
)


def _plan(*steps: tuple[str, str]) -> dict:
    return {"steps": [{"op": op, "urn": urn} for op, urn in steps]}


def self_test() -> int:
    cases: list[tuple[str, dict, list[tuple[str, str]]]] = [
        ("clean create-only plan", _plan(("create", _URN_BUCKET)), []),
        ("no-op plan", _plan(("same", _URN_BUCKET), ("same", _URN_POOL)), []),
        ("update is not a destroy", _plan(("update", _URN_POOL)), []),
        (
            "a platform resource deleted from a provisioning plan",
            _plan(("delete", _URN_DB)),
            [("ghost-platform-db", "delete")],
        ),
        (
            "the shared instance forced-replaced inside a routine-looking run",
            _plan(
                ("create", _URN_UNPROTECTED),
                ("same", _URN_POOL),
                ("replace", _URN_DB),
            ),
            [("ghost-platform-db", "replace")],
        ),
        (
            "the create half of a replacement still counts",
            _plan(("create-replacement", _URN_DB)),
            [("ghost-platform-db", "create-replacement")],
        ),
        ("delete-replaced counts", _plan(("delete-replaced", _URN_POOL)), [(f"{_T}-gha-pool", "delete-replaced")]),
        (
            "this tenant's state bucket replaced",
            _plan(("replace", _URN_BUCKET)),
            [(f"{_T}-pulumi-state", "replace")],
        ),
        ("unprotected resource deleted", _plan(("delete", _URN_UNPROTECTED)), []),
        ("empty plan", _plan(), []),
    ]

    failed = False
    for name, plan, expected in cases:
        actual = destructive_steps(plan, _T)
        ok = actual == expected
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: {name} -> {actual!r} (expected {expected!r})")

    # A protected name is tenant-scoped: another tenant's resource is not this
    # plan's to guard, and pretending otherwise would fail every run.
    other = destructive_steps(_plan(("delete", _URN_BUCKET)), "different-tenant")
    ok = other == []
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'}: another tenant's bucket is not guarded here -> {other!r}")

    for name, bad in [
        ("plan with no steps key", {}),
        ("steps is not a list", {"steps": "nope"}),
        ("step missing urn", {"steps": [{"op": "delete"}]}),
    ]:
        try:
            destructive_steps(bad, _T)
        except ValueError:
            print(f"PASS: {name} raises rather than reporting clean")
        else:
            failed = True
            print(f"FAIL: {name} returned clean instead of raising")

    failed |= _coverage_self_test() != 0

    if failed:
        print("\nThis gate no longer behaves as written. It would report success")
        print("against a plan that destroys protected infrastructure.")
    return 1 if failed else 0


def _coverage_self_test() -> int:
    import tempfile

    platform_decls = "\n".join(
        f"export const r{i} = new gcp.some.Type(\n  '{name}',\n  {{}}\n);"
        for i, name in enumerate(sorted(PLATFORM_PROTECTED))
    )
    platform_renamed = platform_decls.replace("'ghost-platform-db'", "'ghost-platform-db-v2'", 1)
    platform_renamed += (
        "\n// was ghost-platform-db before the rename\n"
        "export const dbInstanceName = 'ghost-platform-db';\n"
    )
    prov_decls = "\n".join(
        f"export const t{i} = new gcp.some.Type(\n  `${{tenantName}}{suffix}`,\n  {{}}\n);"
        for i, suffix in enumerate(sorted(TENANT_SUFFIXES))
    )
    prov_renamed = prov_decls.replace("${tenantName}-gha-pool", "${tenantName}-pool", 1)

    cases = [
        ("both trees intact", platform_decls, prov_decls, 0),
        ("platform resource renamed under this gate", platform_renamed, prov_decls, 1),
        ("provisioning resource renamed", platform_decls, prov_renamed, 1),
    ]

    failed = False
    with tempfile.TemporaryDirectory() as root:
        plat = pathlib.Path(root) / "platform"
        prov = pathlib.Path(root) / "provisioning"
        plat.mkdir()
        prov.mkdir()
        for name, p_src, v_src, expected in cases:
            (plat / "program.ts").write_text(p_src, encoding="utf-8")
            (prov / "index.ts").write_text(v_src, encoding="utf-8")
            actual = verify_coverage(str(plat), str(prov))
            ok = actual == expected
            failed |= not ok
            print(f"{'PASS' if ok else 'FAIL'}: coverage, {name} -> exit {actual} (expected {expected})")

        empty = pathlib.Path(root) / "empty"
        empty.mkdir()
        actual = verify_coverage(str(empty), str(prov))
        ok = actual == 1
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: coverage, empty platform dir -> exit {actual} (expected 1)")

    return 1 if failed else 0


def verify_coverage(platform_dir: str, provisioning_dir: str) -> int:
    """Fail if a protected name is no longer declared in the tree that owns it.

    The quiet way this gate dies is a rename in `infra/platform` that leaves
    this set holding a name nothing produces any more: the plan's URNs stop
    matching, and the gate passes forever while guarding nothing. A bare
    rename is still caught by the plan check; a rename carrying `aliases` is
    not, and this is the only thing standing between that and a dead gate.
    """
    plat = pathlib.Path(platform_dir)
    prov = pathlib.Path(provisioning_dir)
    for label, directory in (("platform", plat), ("provisioning", prov)):
        if not directory.is_dir():
            print(f"::error::not a directory ({label}): {directory}")
            return 1

    plat_sources = sorted(plat.glob("*.ts"))
    prov_sources = sorted(prov.glob("*.ts"))
    if not plat_sources:
        print(f"::error::no .ts files in {platform_dir}; nothing was checked")
        return 1
    if not prov_sources:
        print(f"::error::no .ts files in {provisioning_dir}; nothing was checked")
        return 1

    plat_blob = "\n".join(p.read_text(encoding="utf-8") for p in plat_sources)
    prov_blob = "\n".join(p.read_text(encoding="utf-8") for p in prov_sources)

    missing_platform = [
        n for n in sorted(PLATFORM_PROTECTED) if not _declaration_pattern_literal(n).search(plat_blob)
    ]
    missing_suffix = [
        s for s in sorted(TENANT_SUFFIXES) if not _declaration_pattern_suffix(s).search(prov_blob)
    ]

    if missing_platform:
        print(
            "::error::these platform resource names are guarded here but are "
            f"no longer declared in {platform_dir}/*.ts: "
            f"{', '.join(missing_platform)}. Either infra/platform renamed a "
            "resource and this set was not updated -- in which case this gate "
            "is now protecting nothing -- or it removed one deliberately, and "
            "PLATFORM_PROTECTED should lose it in the same change."
        )
    if missing_suffix:
        print(
            "::error::these provisioning resource suffixes are not declared "
            f"as `${{tenantName}}<suffix>` in {provisioning_dir}/*.ts: "
            f"{', '.join(missing_suffix)}."
        )
    if missing_platform or missing_suffix:
        return 1

    print(
        f"OK: {len(PLATFORM_PROTECTED)} platform names and "
        f"{len(TENANT_SUFFIXES)} provisioning suffixes all still declared."
    )
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        return self_test()
    if len(argv) == 4 and argv[1] == "--verify-coverage":
        return verify_coverage(argv[2], argv[3])
    if len(argv) == 4 and argv[1] == "--tenant":
        tenant, path = argv[2], argv[3]
    else:
        print(__doc__)
        return 2

    try:
        with open(path, encoding="utf-8") as handle:
            plan = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print(f"::error::cannot read preview JSON: {error}")
        return 1

    try:
        found = destructive_steps(plan, tenant)
    except ValueError as error:
        print(f"::error::preview JSON is not a plan this gate understands: {error}")
        return 1

    if found:
        detail = ", ".join(f"{name} ({op})" for name, op in sorted(found))
        print(
            "::error::this apply would DESTROY protected infrastructure: "
            f"{detail}. Nothing has been applied. A provisioning run must "
            "never contain a destructive step -- onboarding creates. See "
            "infra/platform/RUNBOOK-bootstrap.md."
        )
        return 1

    steps = plan.get("steps", [])
    print(
        f"OK: no protected resource is destroyed by this plan "
        f"({len(steps)} steps checked, changeSummary={plan.get('changeSummary', {})})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
