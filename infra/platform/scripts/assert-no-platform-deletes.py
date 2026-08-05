#!/usr/bin/env python3
"""Fail if a `pulumi preview --json` plan would destroy a platform resource.

Run as a preflight inside the CI deploy job, against the *same* stack state
`pulumi up` is about to act on, a few seconds earlier. A pass is therefore a
real statement about that run, not an assumption -- but see "What this cannot
prove" below for the limits.

Usage:
    assert-no-platform-deletes.py <preview-json-file>
    assert-no-platform-deletes.py --self-test
    assert-no-platform-deletes.py --verify-coverage <program-dir>

Exit status 0 if clean, 1 if a protected resource would be destroyed (or if
any input could not be read or understood), 2 on usage error.

Why this exists when `database.ts` already sets two deletion-protection flags:
those flags cover exactly one of the four resources worth protecting. The
media bucket has no equivalent -- `gcp.storage.Bucket` has no
deletion-protection field, and while GCS refuses to delete a *non-empty*
bucket, that is a race with reality, not a guarantee (an empty bucket, or a
bucket emptied by a lifecycle rule, deletes cleanly). The Artifact Registry
repository has none either. And deleting the Workload Identity pool or the
deployer service account locks CI out of the project with no way back through
CI -- worse, a deleted WIF pool is soft-deleted and its ID cannot be reused
for 30 days, so "just re-run the apply" does not recover it.

Why JSON rather than regex over rendered preview text: `website/infra`'s
equivalent (`assert-no-edge-deletes.py`) parses the human-readable output, and
its own docstring records that the first version of it matched nothing,
exited 0, and would have permitted the exact apply it was written to block.
`pulumi preview --json` emits `{"steps": [{"op": ..., "urn": ...}]}`, which
has no such failure mode. Verified against a real run of this program, not
assumed.

That precedent's matcher also keys on `(delete)` alone, which would not fire
on a *replacement* -- a replacement deletes the resource just as thoroughly.
This one flags any op whose name contains "delete" or "replace", which is
fail-closed: an op name added or renamed by a future Pulumi version is far
more likely to be caught than to be silently ignored.

What this cannot prove — two distinct limits, both real:

1. `pulumi preview` compares the program to Pulumi *state*, never to live
   GCP, the same limit `website/infra`'s gate carries. A resource already
   deleted out-of-band still shows as unchanged here. This gate answers
   "will this apply destroy something", not "is the platform intact". A
   periodic `pulumi refresh --preview-only` is the control for the second
   question, and this script is not it.

2. A rename carrying Pulumi's `aliases` resource option produces an in-place
   update with no destructive step at all, so the plan check below correctly
   reports clean. That is the right answer for the apply -- nothing is
   destroyed -- but it silently retires the old logical name, and if
   `PROTECTED` still holds that name the gate would go on passing while
   guarding a resource that no longer exists under it. `--verify-coverage`
   is what closes that: it fails when a `PROTECTED` name is no longer used
   as a resource's logical id, aliased or not. It is deliberately *not* a
   substring search over the sources, because that version of the check
   returned a false "all present" for exactly this case -- the renamed id
   was still matched by an unrelated occurrence of the same text elsewhere
   in the program.
"""

import json
import pathlib
import re
import sys

# Pulumi resource names (the final `::name` segment of a URN) for the
# resources whose loss is not a rollback but an incident.
#
# The two IAM *bindings* on the project are deliberately absent: CI cannot
# change them anyway (no `resourcemanager.projects.setIamPolicy` -- see
# serviceAccounts.ts), so guarding them here would add a second, more
# confusing failure on top of a 403 that already stops the run.
PROTECTED = {
    # Every tenant's data, on one shared instance (doc 02).
    "ghost-platform-db",
    # Every tenant's uploaded media. No deletion-protection field exists for
    # a GCS bucket, which is precisely why it is listed here.
    "ghost-platform-media",
    # Every tenant runs this image; losing the repository loses every pushed
    # tag.
    "ghost-platform-tenant-repo",
    # Destroying any of these three locks CI out of the project. The pool ID
    # is additionally unavailable for 30 days after deletion.
    "ghost-platform-gha-pool",
    "ghost-platform-gha-provider",
    "ghost-platform-deployer-sa",
    "ghost-platform-gha-can-impersonate-deployer",
    # CI's own bucket-scoped grant on the media bucket. Losing it does not
    # lose data, but CI cannot restore it either -- the permission it would
    # need to re-grant it is the one it just lost -- so recovery is a manual
    # gcloud step, same as the impersonation binding above.
    "ghost-platform-media-deployer-manage",
}


def _declaration_pattern(name: str) -> re.Pattern[str]:
    """Match `new <Ctor>('<name>'` -- a resource *declaration*, not a mention.

    Anchored to the constructor call because the obvious implementation --
    searching the sources for the bare name -- reports a false pass. Renaming
    only the logical id in `database.ts` left the same text present elsewhere
    in the program (a GCP-side name constant in `config.ts` that happens to
    share it today), and the check happily reported all names still present
    while the id it was protecting no longer existed.

    Tolerates the argument on the following line, which is how the longer
    resource declarations in this program are formatted.
    """
    return re.compile(rf"""\bnew\s+[\w.]+\(\s*['"]{re.escape(name)}['"]""")

# Any Pulumi step op whose name contains either of these destroys, or
# schedules the destruction of, the resource it names. Covers `delete`,
# `delete-replaced`, `replace`, `create-replacement`, `read-replacement`,
# `import-replacement`, `discard-replaced` and `remove-pending-replace`
# without enumerating them, so a new op name has to actively avoid both words
# to slip through.
DESTRUCTIVE_SUBSTRINGS = ("delete", "replace")


def destructive_steps(plan: dict) -> list[tuple[str, str]]:
    """Return (name, op) for every protected resource this plan would destroy.

    Raises ValueError if `plan` is not a preview plan, rather than returning
    an empty list -- "I could not find any steps" and "there are no
    destructive steps" must not produce the same exit code.
    """
    steps = plan.get("steps")
    if not isinstance(steps, list):
        raise ValueError("no 'steps' array in the preview JSON")

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
        if name in PROTECTED:
            found.append((name, op))
    return found


# Fixtures below use URNs copied verbatim from a real `pulumi preview --json`
# run of this program against the `platform` stack on 2026-08-05. The `op`
# values for the destructive cases are synthesized: the stack was empty at
# that point, so every real step was a `create` and no genuine delete plan
# exists to copy. Saying so plainly -- the URN shape is evidence, the op
# strings are Pulumi's documented step names.
_URN_DB = (
    "urn:pulumi:platform::branchleft-ghost-platform::"
    "gcp:sql/databaseInstance:DatabaseInstance::ghost-platform-db"
)
_URN_BUCKET = (
    "urn:pulumi:platform::branchleft-ghost-platform::"
    "gcp:storage/bucket:Bucket::ghost-platform-media"
)
_URN_POOL = (
    "urn:pulumi:platform::branchleft-ghost-platform::"
    "gcp:iam/workloadIdentityPool:WorkloadIdentityPool::ghost-platform-gha-pool"
)
_URN_UNPROTECTED = (
    "urn:pulumi:platform::branchleft-ghost-platform::"
    "gcp:projects/service:Service::api-storage.googleapis.com"
)


def _plan(*steps: tuple[str, str]) -> dict:
    return {"steps": [{"op": op, "urn": urn} for op, urn in steps]}


def self_test() -> int:
    cases: list[tuple[str, dict, list[tuple[str, str]]]] = [
        ("clean create-only plan", _plan(("create", _URN_DB)), []),
        ("no-op plan", _plan(("same", _URN_DB), ("same", _URN_BUCKET)), []),
        ("update is not a destroy", _plan(("update", _URN_DB)), []),
        ("outright delete", _plan(("delete", _URN_DB)), [("ghost-platform-db", "delete")]),
        (
            "replacement, which website's regex gate would have missed",
            _plan(("replace", _URN_BUCKET)),
            [("ghost-platform-media", "replace")],
        ),
        (
            "the create half of a replacement still counts",
            _plan(("create-replacement", _URN_POOL)),
            [("ghost-platform-gha-pool", "create-replacement")],
        ),
        (
            "delete-replaced counts",
            _plan(("delete-replaced", _URN_POOL)),
            [("ghost-platform-gha-pool", "delete-replaced")],
        ),
        ("unprotected resource deleted", _plan(("delete", _URN_UNPROTECTED)), []),
        (
            "one protected delete hidden among unprotected churn",
            _plan(
                ("create", _URN_UNPROTECTED),
                ("delete", _URN_UNPROTECTED),
                ("update", _URN_POOL),
                ("delete", _URN_BUCKET),
            ),
            [("ghost-platform-media", "delete")],
        ),
        ("empty plan", _plan(), []),
    ]

    failed = False
    for name, plan, expected in cases:
        actual = destructive_steps(plan)
        ok = actual == expected
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: {name} -> {actual!r} (expected {expected!r})")

    # A malformed plan must raise, not return [].
    for name, bad in [
        ("plan with no steps key", {}),
        ("steps is not a list", {"steps": "nope"}),
        ("step missing urn", {"steps": [{"op": "delete"}]}),
    ]:
        try:
            destructive_steps(bad)
        except ValueError:
            print(f"PASS: {name} raises rather than reporting clean")
        else:
            failed = True
            print(f"FAIL: {name} returned clean instead of raising")

    failed |= _coverage_self_test() != 0

    if failed:
        print("\nThis gate no longer behaves as written. It would report success")
        print("against a plan that destroys a protected platform resource.")
    return 1 if failed else 0


def _coverage_self_test() -> int:
    """Prove `--verify-coverage` still distinguishes a declaration from a mention.

    This exists because the substring version of the check did not, and
    reported a clean pass against a program whose protected resource had been
    renamed out from under it. A self-test that only exercised the plan
    matcher would not have caught that.
    """
    import tempfile

    declarations = "\n".join(
        f"export const r{i} = new gcp.some.Type(\n  '{name}',\n  {{}}\n);"
        for i, name in enumerate(sorted(PROTECTED))
    )
    renamed = declarations.replace(
        "'ghost-platform-media'", "'ghost-platform-media-v2'", 1
    )
    # The renamed program still mentions the old name -- as a comment and as
    # a plain string constant, which is exactly the shape that fooled the
    # substring check.
    renamed += (
        "\n// was ghost-platform-media before the rename\n"
        "export const mediaBucketName = 'ghost-platform-media';\n"
    )

    cases = [
        ("every protected name declared", declarations, 0),
        ("one renamed, old name still mentioned in a comment/constant", renamed, 1),
    ]

    failed = False
    with tempfile.TemporaryDirectory() as root:
        for name, source, expected in cases:
            directory = pathlib.Path(root) / name.replace(" ", "_").replace("/", "_")
            directory.mkdir()
            (directory / "program.ts").write_text(source, encoding="utf-8")
            actual = verify_coverage(str(directory))
            ok = actual == expected
            failed |= not ok
            print(f"{'PASS' if ok else 'FAIL'}: coverage, {name} -> exit {actual} (expected {expected})")

        empty = pathlib.Path(root) / "empty"
        empty.mkdir()
        actual = verify_coverage(str(empty))
        ok = actual == 1
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'}: coverage, no .ts files -> exit {actual} (expected 1)")

    return 1 if failed else 0


def verify_coverage(program_dir: str) -> int:
    """Fail if a PROTECTED name no longer appears in the Pulumi program.

    The quiet way this gate dies is not the matcher breaking -- it is someone
    renaming a resource in `database.ts` or `mediaBucket.ts` while PROTECTED
    keeps the old name. Nothing errors: the plan's URNs simply stop matching
    the set, and the gate passes forever while protecting nothing. A bare
    rename is still caught by the plan check (it shows up as a real
    delete + create); a rename carrying `aliases` is not, and this is the
    only thing standing between that and a gate that guards nothing.

    Checking against the program source rather than against a preview is
    deliberate. A steady-state preview's step list depends on which unchanged
    resources Pulumi chooses to emit, so keying on it risks failing every
    deploy for a reason unrelated to safety.
    """
    directory = pathlib.Path(program_dir)
    if not directory.is_dir():
        print(f"::error::not a directory: {program_dir}")
        return 1

    sources = sorted(directory.glob("*.ts"))
    if not sources:
        print(f"::error::no .ts files found in {program_dir}; nothing was checked")
        return 1

    blob = "\n".join(path.read_text(encoding="utf-8") for path in sources)
    missing = [
        name for name in sorted(PROTECTED) if not _declaration_pattern(name).search(blob)
    ]
    if missing:
        print(
            "::error::these protected resource names are in this script's "
            f"PROTECTED set but are not declared as the logical id of any "
            f"resource in {program_dir}/*.ts: {', '.join(missing)}. Either a "
            "resource was renamed and this set was not updated -- in which "
            "case the gate is now protecting nothing -- or a resource was "
            "removed on purpose and should be removed from PROTECTED in the "
            "same change. Note a mention of the name in a comment or a "
            "string constant does not count; it has to be the first argument "
            "to a resource constructor."
        )
        return 1

    print(
        f"OK: all {len(PROTECTED)} protected resource names still appear in "
        f"{len(sources)} program files."
    )
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "--self-test":
        return self_test()
    if len(argv) == 3 and argv[1] == "--verify-coverage":
        return verify_coverage(argv[2])
    if len(argv) != 2:
        print(__doc__)
        return 2

    try:
        with open(argv[1], encoding="utf-8") as handle:
            plan = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        # Must fail. Treating an unreadable plan as an empty one would report
        # "nothing will be destroyed" without having looked at anything.
        print(f"::error::cannot read preview JSON: {error}")
        return 1

    try:
        found = destructive_steps(plan)
    except ValueError as error:
        print(f"::error::preview JSON is not a plan this gate understands: {error}")
        return 1

    if found:
        detail = ", ".join(f"{name} ({op})" for name, op in sorted(found))
        print(
            "::error::this apply would DESTROY protected platform "
            f"infrastructure: {detail}. Nothing has been applied. If this is "
            "genuinely intended it is a Rob-gated migration, not a merge -- "
            "see infra/platform/RUNBOOK-bootstrap.md."
        )
        return 1

    steps = plan.get("steps", [])
    summary = plan.get("changeSummary", {})
    print(
        f"OK: no protected resource is destroyed by this plan "
        f"({len(steps)} steps checked, changeSummary={summary})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
