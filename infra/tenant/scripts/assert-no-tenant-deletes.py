#!/usr/bin/env python3
"""Refuse a tenant stack's plan that destroys or re-identifies live tenant data.

Usage:
    assert-no-tenant-deletes.py <preview-json-file>
    assert-no-tenant-deletes.py --self-test
    assert-no-tenant-deletes.py --verify-coverage <package-dir>

`<preview-json-file>` must come from `pulumi preview --json --show-sames`.
Without `--show-sames`, Pulumi omits a component from `steps` entirely once
its registered inputs stop changing -- proved against a real capture of this
component, not assumed. Without the flag, a tenant that has not changed and a
tenant whose component silently stopped registering its identity as an input
(this guard's original defect; see below) produce the identical empty result,
and this guard cannot tell them apart. `component_is_present()` refuses a plan
that carries no step at all for the component it guards, so a plan captured
without the flag fails closed rather than silently passing.

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
import re
import sys
import tempfile

# Any Pulumi step op containing either word destroys, or schedules the
# destruction of, the resource it names. Covers `delete`, `delete-replaced`,
# `replace`, `create-replacement`, `read-replacement`, `import-replacement`,
# `discard-replaced` and `remove-pending-replace` without enumerating them, so
# a future op name has to actively avoid both words to slip through.
DESTRUCTIVE_SUBSTRINGS = ("delete", "replace")

COMPONENT_TYPE_TOKEN = "ghostPlatform:tenant:GhostTenant"

# The only ops for which "no old state" is the truth rather than a gap.
CREATE_OPS = {"create", "import", "refresh"}

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

        op = step.get("op")
        if not isinstance(op, str):
            raise GuardError(f"step is missing a string 'op': {step!r}")

        old = _identity_of(step.get("oldState"))
        if old is None:
            # A first apply genuinely has no old state. Anything else does --
            # `same`, `update` and every replacement op are defined against an
            # existing resource -- so a missing old identity there means the
            # comparison cannot be made, and an unmade comparison must not
            # exit the same way a passed one does.
            if op in CREATE_OPS:
                continue
            findings.append(
                f"{urn}: a '{op}' step carries no existing identity to compare against. "
                "Refusing rather than passing an unmade check."
            )
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
            if field not in new:
                findings.append(
                    f"{urn}: {field!r} is in the existing identity but missing from the new one. "
                    "A field a plan drops is not a field that stayed the same, and an unmade "
                    "comparison must not exit the same way a passed one does."
                )
                continue
            if old[field] != new[field]:
                findings.append(
                    f"{urn}: {field} would change from {old[field]!r} to {new[field]!r}. "
                    "That is a data migration, not an update — see this script's header."
                )
    return findings


def component_is_present(plan: dict) -> bool:
    """True if `plan` carries at least one step for the guarded component.

    Proved against a real capture rather than assumed: `pulumi preview --json`
    omits a resource from `steps` entirely once its registered inputs stop
    changing, unless the preview was run with `--show-sames`. Without that
    flag, a tenant that has not changed and a tenant whose component silently
    stopped registering its identity as an input -- this guard's original
    defect -- produce the same empty result, and this guard cannot tell them
    apart from the plan alone.
    """
    for step in _steps(plan):
        urn = step.get("urn")
        if isinstance(urn, str) and _type_token(urn) == COMPONENT_TYPE_TOKEN:
            return True
    return False


def check_plan(plan: dict) -> list[str]:
    findings = [f"{urn} would be destroyed by a '{op}' step" for urn, op in destructive_steps(plan)]
    findings.extend(identity_changes(plan))
    if not component_is_present(plan):
        findings.append(
            f"the plan carries no step at all for a {COMPONENT_TYPE_TOKEN!r} resource. Either "
            "it was captured without `pulumi preview --json --show-sames`, or the component "
            "stopped registering its identity as an input. Both leave nothing to compare, and a "
            "check that cannot see its subject must not report success."
        )
    return findings


# PUL-1 — a `super()` call for this component naming `identity` as one of its
# own props, either shorthand (`{ identity }`) or as a key (`{ identity: x }`).
# Anchored to `COMPONENT_TYPE_TOKEN` so a renamed token fails this match too,
# on top of the separate check below that names that failure directly.
_SUPER_IDENTITY_PROP = re.compile(
    r"super\(\s*['\"]" + re.escape(COMPONENT_TYPE_TOKEN) + r"['\"][^)]*?[{,]\s*identity\s*[,}]",
    re.DOTALL,
)


def verify_coverage(package_dir: pathlib.Path) -> list[str]:
    """Assert the component still registers every field this guard compares.

    Reads the built package where one exists and the TypeScript source
    otherwise, so the check works both from a tenant repo's `node_modules` and
    from this repository's own tree.

    Scoped to whatever object `super()` actually passes as `identity`, not to
    `this.identity = pulumi.output(...)`. A preview decides whether a
    component emits a step at all from its *registered inputs* -- what
    `super()` was called with -- never from an output assignment, which a
    preview does not even resolve (see the constructor's own comment). A
    version of this check that read the output instead passed a component
    with genuinely empty props outright, which is the exact defect this guard
    exists to catch; checking the output was never checking the thing that
    determines whether a plan carries a step at all.
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

    if _SUPER_IDENTITY_PROP.search(text) is None:
        findings.append(
            f"{source}'s super() call no longer passes `identity` as one of its own props. A "
            "preview decides whether this component emits a step at all from those registered "
            "inputs, so this guard would have no step to compare."
        )
        return findings

    decl = re.search(r"\bconst\s+identity\b[^=\n]*=\s*\{(.*?)\}\s*;", text, re.DOTALL)
    if decl is None:
        findings.append(
            f"{source} passes `identity` to super() but declares no `const identity = {{...}}` "
            "this check can read its fields from."
        )
        return findings

    registered = decl.group(1)
    for field in IDENTITY_FIELDS:
        if not re.search(rf"\b{re.escape(field)}\s*:", registered):
            findings.append(
                f"{source} no longer registers the identity field {field!r}, so this guard would "
                "compare a field that reaches no plan."
            )
    return findings


# --- self-test ---------------------------------------------------------------
#
# A guard whose matcher has quietly stopped matching passes every input, so the
# refusals are exercised rather than assumed. The `_CAPTURED_*` fixtures below
# are trimmed from real `pulumi preview --json` runs against this component --
# the guard's original defect was exactly a plan shape nobody had captured,
# only assumed, so this is the part that has to stop being hand-built. The
# destructive-op fixtures below them stay synthetic: a `ComponentResource` has
# no provider to produce a genuine `replace`, so there is no real preview to
# capture for those, and they exist to exercise the op-name substring match
# rather than a captured shape.

_URN = f"urn:pulumi:blog::ghost-tenant-blog::{COMPONENT_TYPE_TOKEN}::blog"
_STACK_URN = "urn:pulumi:blog::ghost-tenant-blog::pulumi:pulumi:Stack::ghost-tenant-blog-blog"


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


def _captured_same_stack_step() -> dict:
    """The top-level `pulumi:pulumi:Stack` step every plan carries.

    `same`-shaped exactly as a real preview emits it: `newState` carries no
    `identity` at all, because a component's outputs are not resolved until an
    actual apply -- true of every step below, not just this one, and the
    reason `_identity_of()` has to fall back to `inputs`.
    """
    return {
        "op": "same",
        "urn": _STACK_URN,
        "oldState": {
            "urn": _STACK_URN,
            "type": "pulumi:pulumi:Stack",
            "outputs": {"identity": _identity()},
        },
        "newState": {"urn": _STACK_URN, "type": "pulumi:pulumi:Stack"},
    }


# Trimmed from a real `pulumi preview --json` captured against this component
# after fixing the defect this guard exists to catch: applied once with `uid`
# and `appHostPrivateIp` as above, then both changed in stack config before
# the preview that produced this shape.
#
# This is the shape that made the original bug easy to miss by hand: `uid` and
# `appHostPrivateIp` differ between `oldState` and `newState`, but `newState`
# -- the desired state a preview computes -- carries the identity under
# `inputs` only, never `outputs`.
_CAPTURED_IDENTITY_UPDATE: dict = {
    "steps": [
        _captured_same_stack_step(),
        {
            "op": "update",
            "urn": _URN,
            "oldState": {
                "urn": _URN,
                "type": COMPONENT_TYPE_TOKEN,
                "inputs": {"identity": _identity()},
                "outputs": {"identity": _identity()},
            },
            "newState": {
                "urn": _URN,
                "type": COMPONENT_TYPE_TOKEN,
                "inputs": {"identity": _identity(uid=30099, appHostPrivateIp="10.20.1.101")},
            },
        },
    ]
}

# Trimmed from a real `pulumi preview --json --show-sames` capture against an
# unchanged tenant. Without `--show-sames`, Pulumi omits the second step
# entirely -- this fixture is also what proves `component_is_present()` needs
# that flag to mean anything.
_CAPTURED_SAME: dict = {
    "steps": [
        _captured_same_stack_step(),
        {
            "op": "same",
            "urn": _URN,
            "oldState": {
                "urn": _URN,
                "type": COMPONENT_TYPE_TOKEN,
                "inputs": {"identity": _identity()},
                "outputs": {"identity": _identity()},
            },
            "newState": {
                "urn": _URN,
                "type": COMPONENT_TYPE_TOKEN,
                "inputs": {"identity": _identity()},
            },
        },
    ]
}

# Trimmed from a real first-apply `pulumi preview --json` capture: a `create`
# step carries a `newState` and no `oldState` at all.
_CAPTURED_CREATE: dict = {
    "steps": [
        {"op": "create", "urn": _STACK_URN, "newState": {"urn": _STACK_URN, "type": "pulumi:pulumi:Stack"}},
        {
            "op": "create",
            "urn": _URN,
            "newState": {
                "urn": _URN,
                "type": COMPONENT_TYPE_TOKEN,
                "inputs": {"identity": _identity()},
            },
        },
    ]
}

# Captured from the unfixed component (`super(token, name, {}, opts)`) after
# the same `uid`/`appHostPrivateIp` change as `_CAPTURED_IDENTITY_UPDATE`:
# with empty props, the component registers no step at all, so the identity
# change leaves no trace anywhere in the plan. This is the literal shape that
# let the unfixed guard exit 0 on live tenant data loss -- reproduced locally
# against the published component, not assumed from the bug report.
_CAPTURED_VACUOUS_REGRESSION: dict = {"steps": [_captured_same_stack_step()]}


# Derived, not captured: no `2.0.0`-pinned tenant exists yet to take a genuine
# `pulumi preview --json` from, and this guard must never be run against a
# real stack. Instead built from two things already settled elsewhere in this
# repository, not assumed:
#
# - `git show v2.0.0:infra/tenant/index.ts` calls `super(COMPONENT_TYPE_TOKEN,
#   name, {}, opts)` -- empty registered props, so `inputs` on the persisted
#   resource is empty -- but calls `this.registerOutputs({identity:
#   this.identity, ...})`, so that same resource's `outputs.identity` is fully
#   populated. A tenant deployed under `2.0.0` is left in exactly this shape.
# - `_CAPTURED_IDENTITY_UPDATE` above, itself a real capture, already
#   establishes what an `update` step's `newState` looks like for this
#   component: `identity` under `inputs` only, never `outputs` -- a
#   component's outputs are not resolved until an apply, true of every step
#   here (see `_captured_same_stack_step()`).
#
# Confidence: high on structure -- both source facts were read from the tagged
# commits, not recalled -- but this is still a derived shape, not a substitute
# for a genuine capture once a `2.0.0`-pinned tenant exists to take one from.
#
# Every identity field, not just one, is varied against this shape below: the
# old identity here is reachable only through `outputs` and the new one only
# through `inputs`, a combination none of the fixtures above exercise, and a
# comparison that quietly narrowed to a single field for that combination
# would still look correct against a fixture that only ever changed `uid`.
def _upgrade_from_2_0_0_step(*, new_identity: dict | None = None) -> dict:
    """An `update` step in the exact shape a `2.0.0`-deployed tenant presents
    the first time it previews under `3.0.0`: old identity resolvable only
    through `outputs`, new identity resolvable only through `inputs`."""
    return {
        "op": "update",
        "urn": _URN,
        "oldState": {
            "urn": _URN,
            "type": COMPONENT_TYPE_TOKEN,
            "inputs": {},
            "outputs": {"identity": _identity()},
        },
        "newState": {
            "urn": _URN,
            "type": COMPONENT_TYPE_TOKEN,
            "inputs": {"identity": _identity() if new_identity is None else new_identity},
        },
    }


_UPGRADE_FROM_2_0_0_UNCHANGED: dict = {"steps": [_captured_same_stack_step(), _upgrade_from_2_0_0_step()]}


def _upgrade_from_2_0_0_changed(**overrides) -> dict:
    """The same 2.0.0-shaped upgrade step, with one or more identity fields
    changed in the new state. A separate function rather than a second module
    constant, because the self-test below needs one of these per field -- see
    its comment for why every field, not just one, has to be exercised here."""
    return {"steps": [_captured_same_stack_step(), _upgrade_from_2_0_0_step(new_identity=_identity(**overrides))]}


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

    # Captured, not assumed: proven against trimmed real `pulumi preview
    # --json` runs (see the fixtures above and the module docstring for how
    # they were produced), rather than only the hand-built shapes above.
    expect(
        check_plan(_CAPTURED_IDENTITY_UPDATE) != [],
        "a captured plan with a changed uid and appHostPrivateIp must be refused",
    )
    expect(check_plan(_CAPTURED_SAME) == [], "a captured plan for an unchanged tenant must pass")
    expect(check_plan(_CAPTURED_CREATE) == [], "a captured first-apply plan must pass")

    # Derived (see the comment above the fixtures): the 2.0.0-shaped upgrade
    # state, where old identity lives only in outputs and new identity only
    # in inputs. An unchanged tenant must still pass in this shape, and every
    # field -- not just one -- must still be caught as a difference rather
    # than lost in the outputs-to-inputs handoff.
    expect(
        check_plan(_UPGRADE_FROM_2_0_0_UNCHANGED) == [],
        "an unchanged tenant upgrading from a 2.0.0-shaped state must pass",
    )
    for field, changed in (
        ("slug", "news"),
        ("uid", 30002),
        ("stackName", "news"),
        ("contentVolume", "ghost-news-content"),
        ("adaptersVolume", "ghost-news-adapters"),
        ("databaseName", "ghost_news"),
        ("appHostPrivateIp", "10.20.1.101"),
    ):
        expect(
            check_plan(_upgrade_from_2_0_0_changed(**{field: changed})) != [],
            f"a changed {field} on a 2.0.0-shaped upgrade must be refused",
        )

    # The guard must not be silently vacuous. A plan carrying no step at all
    # for the component cannot be compared and must be refused, not passed --
    # this is the literal regression `_CAPTURED_VACUOUS_REGRESSION` reproduces.
    expect(
        check_plan(_CAPTURED_VACUOUS_REGRESSION) != [],
        "a plan with no step at all for the component must be refused, not passed",
    )
    expect(check_plan({"steps": []}) != [], "a completely empty plan must be refused, not passed")
    expect(
        component_is_present(_CAPTURED_IDENTITY_UPDATE),
        "a plan with an update step for the component must register as present",
    )
    expect(
        not component_is_present(_CAPTURED_VACUOUS_REGRESSION),
        "a plan with no step for the component must register as absent",
    )

    # Fails closed rather than passing an unmade comparison, in both
    # directions. The `same`/`update`-with-no-old-state case is the one an
    # earlier form of this script let through with a bare `continue`.
    expect(
        check_plan(_plan("update", old=_identity())) != [],
        "a plan with no new identity must be refused",
    )
    for op in ("same", "update"):
        expect(
            check_plan(_plan(op, new=_identity())) != [],
            f"a '{op}' step with no existing identity must be refused",
        )
    expect(
        check_plan(_plan("create", new=_identity())) == [],
        "a create genuinely has no old state and must still pass",
    )
    old_missing = _identity()
    del old_missing["contentVolume"]
    expect(
        check_plan(_plan("update", old=old_missing, new=_identity())) != [],
        "existing state missing an identity field must be refused",
    )
    # The other direction: a field present in the old identity but dropped
    # from the new one. Not reachable from today's `index.ts`, which registers
    # all eight fields unconditionally, but a bare `if field in new` here once
    # let this through with no finding at all -- the same silent vacuity this
    # guard exists to eliminate, one field of granularity down.
    new_missing = _identity()
    del new_missing["uid"]
    expect(
        check_plan(_plan("update", old=_identity(), new=new_missing)) != [],
        "a field dropped from the new identity must be refused, not silently skipped",
    )

    # A plan it cannot parse is an error, never a pass.
    for malformed in ({}, {"steps": "no"}, {"steps": [{"op": "same"}]}):
        try:
            check_plan(malformed)
        except GuardError:
            pass
        else:
            failures.append(f"a malformed plan must raise: {malformed!r}")

    # Coverage verification finds a component that stopped registering a field
    # as part of `super()`'s own props -- the thing a real preview actually
    # reads, not the `this.identity = pulumi.output(...)` output assignment.
    with tempfile.TemporaryDirectory() as tmp:
        package = pathlib.Path(tmp)

        def component(fields, *, token=COMPONENT_TYPE_TOKEN):
            body = "".join(f"      {field}: this.{field},\n" for field in fields)
            return (
                f"    const identity = {{\n{body}    }};\n"
                f"    super('{token}', name, {{ identity }}, opts);\n"
                "    this.identity = pulumi.output(identity);\n"
            )

        (package / "index.ts").write_text(component(IDENTITY_FIELDS), encoding="utf-8")
        expect(verify_coverage(package) == [], "a component naming every field must pass coverage")

        (package / "index.ts").write_text(component(IDENTITY_FIELDS[1:]), encoding="utf-8")
        expect(
            verify_coverage(package) != [],
            "a component that stopped registering a field must fail coverage",
        )

        # The case a whole-file substring search passes and this one must not:
        # dropped from the registration, still named by the interface.
        interface = "export interface GhostTenantIdentity { " + "; ".join(
            f"{field}: string" for field in IDENTITY_FIELDS
        ) + " }\n"
        (package / "index.ts").write_text(
            interface + component(IDENTITY_FIELDS[1:]), encoding="utf-8"
        )
        expect(
            verify_coverage(package) != [],
            "a field dropped from the registration but kept in the interface must fail coverage",
        )

        (package / "index.ts").write_text(component(IDENTITY_FIELDS, token="x:y:Z"), encoding="utf-8")
        expect(
            verify_coverage(package) != [],
            "a component that renamed its type token must fail coverage",
        )

        (package / "index.ts").write_text(f"super('{COMPONENT_TYPE_TOKEN}', name);\n", encoding="utf-8")
        expect(
            verify_coverage(package) != [],
            "a component that registers no identity props at all must fail coverage",
        )

        # The regression this check exists to close: every field present in
        # the *output* assignment is not evidence the *props* carry them too,
        # and the props are what a real preview reads (see this function's
        # docstring). A version of this check that read the output alone
        # passed exactly this shape.
        body = "".join(f"      {field}: this.{field},\n" for field in IDENTITY_FIELDS)
        output_only = (
            f"    super('{COMPONENT_TYPE_TOKEN}', name, {{}}, opts);\n"
            f"    this.identity = pulumi.output({{\n{body}    }});\n"
        )
        (package / "index.ts").write_text(output_only, encoding="utf-8")
        expect(
            verify_coverage(package) != [],
            "empty super() props with a fully-registered output must still fail coverage",
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
