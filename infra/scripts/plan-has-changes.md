# plan-has-changes

`plan-has-changes.py` decides whether a plan job's Pulumi plan would change
anything. Each plan job publishes the answer as the step output `has_changes`.
Its apply job skips on an explicit `false`, so a no-op plan never reaches the
apply's environment and the owner is not asked to approve it. The first line of
the plan job's summary says which way it went.

## The rule

Only a recognised, clean plan is `false`. Everything else is `true`: a missing
or unparseable file, an unknown shape, an unexpected error. A wrong `true`
costs one approval click. A wrong `false` would silently skip a real change, so
the script is built so that it can only err towards `true`.

The script reads two files from the same plan job:

- `preview.json`, from `pulumi preview --json`. The root stack step is always
  listed here; other unchanged resources are hidden, so a real no-op lists one
  step while its change summary counts several `same`. The summary's `same`
  count must therefore be at least the number of `same` steps listed, not equal
  to it.
- The saved update plan, from `pulumi preview --save-plan`. The preview JSON
  has no outputs section, so an output-only change is invisible in it. The
  saved plan carries the root stack's output diff (`adds`, `updates`,
  `deletes`). UNVERIFIED, from the CLI source and not observed live: the diff
  is computed on decrypted in-memory values, so an unchanged secret is no diff
  and a changed one is an entry. The plan holds secrets as ciphertext and
  unknown values as a sentinel string; neither is ever read or printed here.

The plan relies on `--save-plan`, which the CLI help labels as a preview
feature. It is run in its own step, so the `preview.json` that the delete guard
and the apply jobs read is produced exactly as before.

## What a clean plan carries

The allowlists in the script (`PREVIEW_KEYS`, `PLAN_KEYS`, `STEP_KEYS`,
`ENTRY_KEYS`, `GOAL_KEYS`) hold the keys seen in a real plan and preview from a
local run of Pulumi CLI v3.255.0 against a throwaway stack (create cases only),
plus five keys read from the CLI source and never seen in a run (`diagnostics`,
`maybeCorrupt`, `oldState`, `diffReasons` and `replaceReasons`, named below). Any other key
at those levels is a shape change and gives `true`. The tests pin each list to
exactly the observed keys plus the code-only ones named below.

- Observed in the preview: `steps`, `duration`, `changeSummary` and `config`.
  Read from the code, not observed: `diagnostics` and `maybeCorrupt` (a clean
  run is expected to omit them or leave them empty).
- Observed on a preview step: `op`, `urn`, `provider`, `newState` and
  `detailedDiff`. Read from the code, not observed: `oldState`, `diffReasons`
  and `replaceReasons`.
- Observed in the plan: `manifest`, `config` and `resourcePlans`. An entry
  carries `goal`, `steps`, `state` and `seed`. A goal carries `type`, `name`,
  `custom`, `inputDiff`, `outputDiff`, `protect`, `customTimeouts`, and for a
  child `parent`, `provider` and `propertyDependencies`. Every entry seen had
  both diffs.
- Keys the CLI can write that none of those runs showed, such as
  `dependencies`, `ignoreChanges` or `aliases` on a goal, are not allowlisted.
  A stack whose resources use them gets `true` until the allowlist is widened
  from a real clean plan.
- No `same` step was observed. By the CLI source a `same` step has both states:
  the old one holds the `id` and `outputs`, and the new one is read before it
  copies them. Every other state key is compared, as the next section says.

A real clean plan, from the local run, shows these goal values: `protect`
`false`, `customTimeouts` `{}`, `custom` a boolean, `name` and `type` those of
the resource, and for a child a `parent` that is the root stack and a `provider`
string. A goal that holds anything else for those fields is a change.

Three plan fields are read for their type only, and their content is ignored on
purpose: `manifest`, `config` and `seed`. They carry no statement of what
changes. Likewise the preview's `config` and `duration` are checked for type
only. The plan entry's `state` is the resource's outputs property map
(`plan.go` lines 226 to 232), and it is compared for the root stack only: each
plain key that both it and the preview's old root outputs hold must be equal
(type-tagged, as below), and a difference is `output-changed`. A secret is
skipped when the plan holds one and the preview holds `[secret]` or a secret
too (the plan holds ciphertext with a fresh nonce each time); a secret against
a plain value, or `[secret]` against one, is a difference. A key on one side
only is the output diff's to report. A child's plan `state` is not compared (its `id` sits among the plain
outputs, and a preview that hides the child has nothing to compare it with).

## What makes a plan `false`

All of these hold:

- Both files parse as JSON, with no duplicate keys, no `NaN`, `Infinity` or
  overflowing number, and no nesting beyond a fixed depth. They are two
  different files.
- Both carry only the allowlisted keys at every level above.
- Exactly one step in the preview, and exactly one entry in the plan, has the
  stack type `pulumi:pulumi:Stack` as its own type, and it is the exact type,
  named `<project>-<stack>`. A second stack-typed resource, even one nested
  under a parent type, or a stack type matched only as a suffix, is not a root.
  A resource name containing `::` is refused, so a name cannot imitate another
  URN.
- The preview and the plan name the same root stack URN, so a plan for another
  stack or project is refused.
- Every preview step is `same`. A `same` step has both states as objects, and
  its `detailedDiff`, `diffReasons` and `replaceReasons` are absent, null or
  empty; any other type is refused. Its states agree on every key they hold,
  a key on one side only counting as a difference (`protect`, `dependencies`,
  `aliases`, `customTimeouts`, `propertyDependencies`, `parent`, `provider`,
  `inputs` and the rest alike). The engine persists the new state of a `same`
  step as it is, and `protect` drives its deletion guard, so none is skipped.
  There are two exceptions, each named in the script and pinned by a test.
  `id` and `outputs` are compared only when both sides hold them: the step
  copies them from the old state when it applies (`step.go` `SameStep.Apply`,
  lines 177 to 179), so the new state in the preview does not hold them yet.
  `sourcePosition` and `stackTrace` are not compared: the engine sets them from
  the program run being previewed (`step_generator.go` lines 812 and 813), so an
  edit that only moves a line changes them on every resource, and nothing reads
  them to decide a delete or an update. A custom resource other than a provider
  must carry a provider in its new state (`NewSameStep`, `step.go` lines 107 to
  128); one that does not is a change. The exemption for a provider tests the
  state's whole `type` token, exactly `pulumi:providers:<package>`
  (`reference.go` lines 40 to 46), and a state `type` that is not the type in
  the resource's own URN is a change. Values compare type-tagged: a bool is
  never a number, so `false` against `0` differs, in nested objects and lists
  too; two numbers compare by value. `custom` must be a bool on both sides. A
  truthy `taint`, `pendingReplacement`, `delete` or `initErrors` on either side
  is a change, whatever the other side holds. The same URN listed twice is
  `preview-shape` (after the operation check, so a duplicated create still says
  the steps changed). Whether Pulumi ever emits a `same` step
  that fails these rules is not verified; they can only push towards `true`.
  Two costs follow: a resource carrying `importID` or `snippetID` in its old
  state is expected to read `true` always, because the new state is built from
  the program and does not carry them.
- The change summary counts nothing but `same`: a zero count for another
  operation is allowed. The summary's `same` is at least the `same` steps listed.
- `diagnostics` is absent, null or an empty list, and `maybeCorrupt` is absent,
  null or `false`; any other value is refused. The preview's `config` is
  absent or an object and its `duration` absent or a non-negative integer, as
  in the local run; the plan's `manifest` and `config` are absent or objects.
- Source line numbers in this file are those of Pulumi v3.255.0, the version of
  the local run.
- Every plan entry, the root's included, has a non-empty list of string steps,
  all `same`, and a goal with both an `inputDiff` and an `outputDiff`. Both
  diffs must be present on every entry: an absent one is not an empty one. They
  are empty objects of the expected collection types: `adds` and `updates` are
  objects and `deletes` is a list. A null collection is not an empty one.
- Every goal field holds a clean value or is absent. `type` and `name` are the
  resource's own. `protect` is `false`, so a plan with a protected resource
  always reads `true`: the plan holds only the desired value, and a resource the
  preview hides cannot be checked for a change to it. `customTimeouts` is empty.
  `custom` is a boolean. `parent`, when present, is another entry of the same
  plan, in the same stack and project, whose type builds this resource's type
  (a child of the root has a plain type, a child of a component has the
  component's type, then `$`, then its own); an entry with a `$` in its type and
  no parent is refused. `provider` is a
  non-empty string and `propertyDependencies` maps names to lists of strings,
  their contents unchecked. A change to those two on a resource the preview
  hides cannot be seen. Where the preview lists the resource, its goal and its
  new state agree on `custom`, `parent` and `provider`, and its new state does
  not have `protect` set. The preview always lists the root, whose new state
  has no parent, so a root goal with a parent is refused by this agreement.
- A non-root entry with a non-empty output diff is a change too, because
  registering outputs on a component sets its entry's output diff.

## Reason codes

The script prints `has_changes=<bool> reason=<code> count=<n>` and nothing from
either file. The codes are `no-changes`, `steps-changed`, `summary-changed`,
`output-changed`, `no-root-stack`, `stack-mismatch`, `same-file`,
`preview-unreadable`, `preview-shape`, `preview-diagnostics`, `plan-unreadable`,
`plan-shape` and `internal-error`.

When a plan is refused because of keys it does not know or a protected
resource, the summary's second line, and one stdout line, add the names after
the code, for example `plan-shape: unrecognised goal key(s): aliases,
ignoreChanges`. Only key names and, for `protect`, resource type tokens are
printed, never a value, a resource name or a secret: a name that is not plain
(letters, digits and `_.:/$-`, up to 80 long, no `::`) prints as `<odd name>`,
and more than twenty are cut with a count. That line is how the allowlists get
widened from a real plan: the first run on a stack names exactly what to add.

## Output paths

Both `--github-output` and `--github-summary` are required. A blank path, an
existing target that is not a regular file (a device such as `/dev/null`, a
symlink to one, a directory), a symlink to a missing target (opening it to
append would create the target, a file nothing reads), and one file named for
both flags, whether by one path, a symlink or a hard link, are refused with
exit 1 and nothing written. Two paths are the same file when they have the same
device and inode. An unwritable path also exits 1. A skipped write would turn an
unpublished verdict into no approval.

## Limits

- The output-only skip rests on the saved plan's root output diff as observed
  on a local create case against a throwaway local stack. A real `same` plan and
  a real output-only change have not been observed. If a real plan fails one of
  the strict checks, the answer is `true`, which is the behaviour before this
  script existed.
- The plan describes what the CLI would do given the state it reads. A change
  made outside Pulumi (drift) shows up only if a refresh is part of the preview.
- The Pulumi CLI is not pinned. A version that changes the shape makes the
  script fall back to `true`.
- Named gaps, left open. A hidden child's plan `state` is not compared with
  anything. A nested `null` against an absent key reads `true` (the safe side).
  A resource whose goal uses a key not on the allowlist, and any protected
  resource, reads `true` until the allowlist is widened from a real plan; the
  summary names them.
- Unprotecting a resource the preview hides is NOT verified as invisible. An
  earlier copy of this text said it was; that claim is withdrawn. Pulumi is
  expected to list a `same` step whose `protect` flag changed, and this check
  compares each `same` step's old and new state, so such a step reads `true`.
  Not observed live.
- Widening the goal allowlist (`dependencies`, `ignoreChanges`, `aliases`,
  `structuredAliases`) or accepting `protect: true` is a loosening, and is an
  owner decision. Until then a stack that carries any of them always asks for
  approval.

## Tests

`test_plan_has_changes.py` holds a fixture and a test for each rule above. The
script keeps `from __future__ import annotations`, so it imports on Python 3.9;
a test pins that import.
`test_apply_has_changes_gate.py` checks, on both infra workflows, that each
apply job's `if:` carries the push, main and `has_changes != 'false'` operands
joined by `&&`, and that each plan job publishes `has_changes` from the
decision step, which runs before the summary write.
