#!/usr/bin/env python3
"""Refuse a tenant stack's plan that destroys or re-identifies live tenant data.

Usage:
    assert-no-tenant-deletes.py <preview-json-file>
    assert-no-tenant-deletes.py --self-test
    assert-no-tenant-deletes.py --verify-coverage <package-dir>

Exit 0 when the plan is clean, 1 on any finding (or when any input could not be
read or understood), 2 on usage error.

**This guard ships inside `@branchleft/ghost-platform-tenant`, not inside the
tenant repo that runs it.** The earlier GCP-era guard lived in the template and
carried a literal list of the component's child-resource names, which meant a
version bump of the component could rename what the guard was watching without
touching the guard. Shipping it beside the component it guards makes the two
one artifact: a rename is a diff in this directory.

Two halves, guarding two different failures.

**1. Nothing in a tenant plan may be destroyed or replaced.** Default-deny,
with no protected-name list at all, because under the Hetzner shape a tenant
program declares no cloud resources — its whole content is configuration, and a
routine apply can only ever be `create`, `same` or `update`. A `delete` or a
`replace` in a tenant plan is therefore always either a teardown that belongs
in a deliberate `pulumi destroy`, or a refactor that has not been thought
through. A name list would have to be kept in step with the component; "no
destructive step at all" needs no maintenance and cannot silently empty.

**2. The tenant's identity may not change under an existing stack.** This is
the half a plan guard cannot express as an op, because every one of these
arrives as a clean `update`:

  - the content volume name — the tenant's themes, settings, routes and
    generated assets are orphaned on the host under the old name, and Ghost
    boots onto an empty volume that reseeds from the image as though the site
    were new;
  - the UID — the content volume is mode `0700` to the old number, so the
    container starts and then cannot read its own data;
  - the database name — Ghost boots against an empty schema and runs its
    migrations into it;
  - the slug or stack name — the Compose project, systemd unit and secrets
    file all move, leaving the running stack orphaned under the old name;
  - the app host address — the tenant is published on a host the edge is not
    routing to.

None of those is destructive to Pulumi and every one of them is destructive to
the tenant. They are compared here from `GhostTenant`'s own `identity` output.

**What this cannot prove**, both limits real and inherited from every plan
guard in this estate:

1. `pulumi preview` compares the program to Pulumi *state*, never to the live
   host. A volume already deleted out of band still reads as unchanged.
2. Nothing in a plan guard constrains a direct action outside Pulumi. The
   host-side refusals in `app/provision/provision_tenant_volume.py` are the
   control for that path; this is defence in depth on top.
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile

# Any Pulumi step op containing either word destroys, or schedules the
# destruction of, the resource it names. Covers `delete`, `delete-replaced`,
# `replace`, `create-replacement`, `read-replacement`, `import-replacement`,
# `discard-replaced` and `remove-pending-replace` without enumerating them, so
# a future op name has to actively avoid both words to slip through.
DESTRUCTIVE_SUBSTRINGS = ("delete", "replace")

COMPONENT_TYPE_TOKEN = "ghostPlatform:tenant:GhostTenant"

# Every field of `GhostTenantIdentity`. Named here rather than read from the
# plan so that a field the component stops registering is a coverage failure
# instead of a comparison that silently stops happening.
IDENTITY_FIELDS = (
    "slug",
    "uid",
    "stackName",
    "contentVolume",
    "adaptersVolume",
    "databaseName",
    "appHostPrivateIp",
)


class GuardError(Exception):
    """Raised for a plan or package tree this script cannot read."""


def _type_token(urn: str) -> str:
    """Return the type token from a Pulumi URN.

    A URN is `urn:pulumi:<stack>::<project>::<type>::<name>`; a parent chain
    appears in `<type>` as `<parent>$<type>`, so the last `$`-separated part is
    the resource's own type.
    """
    parts = urn.rsplit("::", 2)
    if len(parts) != 3:
        raise GuardError(f"not a resource URN: {urn!r}")
    return parts[1].rsplit("$", 1)[-1]


def _steps(plan: dict) -> list[dict]:
    steps = plan.get("steps")
    if not isinstance(steps, list):
        raise GuardError("no 'steps' array in the preview JSON")
    for step in steps:
        if not isinstance(step, dict):
            raise GuardError(f"malformed step entry: {step!r}")
    return steps


def destructive_steps(plan: dict) -> list[tuple[str, str]]:
    """Return (urn, op) for every step that would destroy or replace anything."""
    found: list[tuple[str, str]] = []
    for step in _steps(plan):
        op = step.get("op")
        urn = step.get("urn")
        if not isinstance(op, str) or not isinstance(urn, str):
            raise GuardError(f"step is missing a string 'op' or 'urn': {step!r}")
        if any(word in op for word in DESTRUCTIVE_SUBSTRINGS):
            found.append((urn, op))
    return found


def _identity_of(state: object) -> dict | None:
    if not isinstance(state, dict):
        return None
    for key in ("outputs", "inputs"):
        block = state.get(key)
        if isinstance(block, dict) and isinstance(block.get("identity"), dict):
            return block["identity"]
    return None


def identity_changes(plan: dict) -> list[str]:
    """Return a finding for every tenant-identity field a plan would change.

    Fails closed twice over: a step against the component whose old state
    carries an identity but whose new state does not is itself a finding,
    because a comparison that cannot be made is not a comparison that passed.
    """
    findings: list[str] = []
    for step in _steps(plan):
        urn = step.get("urn")
        if not isinstance(urn, str) or _type_token(urn) != COMPONENT_TYPE_TOKEN:
            continue

        old = _identity_of(step.get("oldState"))
        if old is None:
            # A first apply has no old state to compare against.
            continue

        new = _identity_of(step.get("newState"))
        if new is None:
            findings.append(
                f"{urn}: the plan carries this tenant's existing identity but not its new one, "
                "so no comparison is possible. Refusing rather than passing an unmade check."
            )
            continue

        for field in IDENTITY_FIELDS:
            if field not in old:
                findings.append(
                    f"{urn}: existing state has no '{field}' in its identity output — the "
                    "stack predates this guard's contract and must be reconciled by hand."
                )
                continue
            if field in new and old[field] != new[field]:
                findings.append(
                    f"{urn}: {field} would change from {old[field]!r} to {new[field]!r}. "
                    "That is a data migration, not an update — see this script's header."
                )
    return findings


def check_plan(plan: dict) -> list[str]:
    findings = [f"{urn} would be destroyed by a '{op}' step" for urn, op in destructive_steps(plan)]
    findings.extend(identity_changes(plan))
    return findings


def verify_coverage(package_dir: pathlib.Path) -> list[str]:
    """Assert the component still registers every field this guard compares.

    Reads the built package where one exists and the TypeScript source
    otherwise, so the check works both from a tenant repo's `node_modules` and
    from this repository's own tree.
    """
    candidates = [package_dir / "dist" / "index.js", package_dir / "index.ts"]
    source = next((path for path in candidates if path.is_file()), None)
    if source is None:
        raise GuardError(
            f"no component source under {package_dir}: looked for "
            + ", ".join(str(candidate) for candidate in candidates)
        )
    text = source.read_text(encoding="utf-8")

    findings: list[str] = []
    if COMPONENT_TYPE_TOKEN not in text:
        findings.append(
            f"{source} no longer declares the type token {COMPONENT_TYPE_TOKEN!r}, so this "
            "guard would match no step in any plan."
        )
    for field in IDENTITY_FIELDS:
        if field not in text:
            findings.append(
                f"{source} no longer names the identity field {field!r}, so this guard would "
                "compare a field the component never registers."
            )
    return findings


# --- self-test ---------------------------------------------------------------
#
# A guard whose matcher has quietly stopped matching passes every input, so the
# refusals are exercised rather than assumed. Every fixture below is a plan
# shape the real Pulumi CLI emits.

_URN = f"urn:pulumi:blog::ghost-tenant-blog::{COMPONENT_TYPE_TOKEN}::blog"


def _identity(**overrides) -> dict:
    base = {
        "slug": "blog",
        "uid": 30001,
        "stackName": "blog",
        "contentVolume": "ghost-blog-content",
        "adaptersVolume": "ghost-blog-adapters",
        "databaseName": "ghost_blog",
        "appHostPrivateIp": "10.20.1.100",
        "maxUserConnections": 10,
    }
    base.update(overrides)
    return base


def _plan(op: str, *, old: dict | None = None, new: dict | None = None) -> dict:
    step: dict = {"op": op, "urn": _URN}
    if old is not None:
        step["oldState"] = {"urn": _URN, "outputs": {"identity": old}}
    if new is not None:
        step["newState"] = {"urn": _URN, "outputs": {"identity": new}}
    return {"steps": [step]}


def _self_test() -> int:
    failures: list[str] = []

    def expect(condition: bool, message: str) -> None:
        if not condition:
            failures.append(message)

    # A first apply and a no-op are clean.
    expect(check_plan(_plan("create", new=_identity())) == [], "a create must pass")
    expect(
        check_plan(_plan("same", old=_identity(), new=_identity())) == [],
        "an unchanged tenant must pass",
    )
    expect(
        check_plan(_plan("update", old=_identity(), new=_identity(maxUserConnections=20))) == [],
        "a change outside the identity fields must pass",
    )

    # Every destructive op is refused, whatever it is called.
    for op in (
        "delete",
        "replace",
        "delete-replaced",
        "create-replacement",
        "discard-replaced",
        "remove-pending-replace",
    ):
        expect(check_plan(_plan(op, old=_identity())) != [], f"a '{op}' step must be refused")

    # Every identity field is compared.
    for field, changed in (
        ("slug", "news"),
        ("uid", 30002),
        ("stackName", "news"),
        ("contentVolume", "ghost-news-content"),
        ("adaptersVolume", "ghost-news-adapters"),
        ("databaseName", "ghost_news"),
        ("appHostPrivateIp", "10.20.1.101"),
    ):
        plan = _plan("update", old=_identity(), new=_identity(**{field: changed}))
        expect(check_plan(plan) != [], f"a changed {field} must be refused")

    # Fails closed rather than passing an unmade comparison.
    expect(
        check_plan(_plan("update", old=_identity())) != [],
        "a plan with no new identity must be refused",
    )
    old_missing = _identity()
    del old_missing["contentVolume"]
    expect(
        check_plan(_plan("update", old=old_missing, new=_identity())) != [],
        "existing state missing an identity field must be refused",
    )

    # A plan it cannot parse is an error, never a pass.
    for malformed in ({}, {"steps": "no"}, {"steps": [{"op": "same"}]}):
        try:
            check_plan(malformed)
        except GuardError:
            pass
        else:
            failures.append(f"a malformed plan must raise: {malformed!r}")

    # Coverage verification finds a component that stopped registering a field.
    with tempfile.TemporaryDirectory() as tmp:
        package = pathlib.Path(tmp)
        (package / "index.ts").write_text(
            f"'{COMPONENT_TYPE_TOKEN}' " + " ".join(IDENTITY_FIELDS), encoding="utf-8"
        )
        expect(verify_coverage(package) == [], "a component naming every field must pass coverage")

        (package / "index.ts").write_text(
            f"'{COMPONENT_TYPE_TOKEN}' " + " ".join(IDENTITY_FIELDS[1:]), encoding="utf-8"
        )
        expect(
            verify_coverage(package) != [],
            "a component that stopped registering a field must fail coverage",
        )

        (package / "index.ts").write_text(" ".join(IDENTITY_FIELDS), encoding="utf-8")
        expect(
            verify_coverage(package) != [],
            "a component that renamed its type token must fail coverage",
        )

    try:
        verify_coverage(pathlib.Path("/nonexistent-package-dir"))
    except GuardError:
        pass
    else:
        failures.append("a missing package tree must raise rather than pass")

    for failure in failures:
        print(f"self-test FAILED: {failure}", file=sys.stderr)
    if failures:
        return 1
    print("assert-no-tenant-deletes.py self-test passed")
    return 0


def _read_plan(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            plan = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise GuardError(f"could not read {path}: {exc}") from exc
    if not isinstance(plan, dict):
        raise GuardError(f"{path} is not a JSON object")
    return plan


def main(argv: list[str]) -> int:
    if len(argv) == 1 and argv[0] == "--self-test":
        return _self_test()

    if len(argv) == 2 and argv[0] == "--verify-coverage":
        try:
            findings = verify_coverage(pathlib.Path(argv[1]))
        except GuardError as exc:
            print(f"assert-no-tenant-deletes: {exc}", file=sys.stderr)
            return 1
        for finding in findings:
            print(f"COVERAGE: {finding}", file=sys.stderr)
        return 1 if findings else 0

    if len(argv) != 1 or argv[0].startswith("--"):
        print(__doc__.split("Exit 0")[0].strip(), file=sys.stderr)
        return 2

    try:
        findings = check_plan(_read_plan(argv[0]))
    except GuardError as exc:
        print(f"assert-no-tenant-deletes: {exc}", file=sys.stderr)
        return 1

    for finding in findings:
        print(f"REFUSED: {finding}", file=sys.stderr)
    if findings:
        print(
            "This plan would destroy or re-identify live tenant data. Nothing in a tenant "
            "stack is destroyed by a routine apply.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
