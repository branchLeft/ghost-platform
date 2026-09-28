# test_provision_tenant_flow_gate.py

## Module overview

Nothing else in this repository referenced FLOW_READY before this file: the
control that stops all tenant creation was defended only by a human reading
the YAML.

This file lives beside the other provisioning guard tests so
`python3 -m unittest discover -s scripts -p 'test_*.py'` — already run by
infra-provisioning-scripts-ci.yml's `Scripts unit tests` job — picks it up
with no workflow change. It differs from its neighbours in reading the *workflow*
file rather than importing a script under test: the gate lives entirely as
inline shell in the YAML, with no extracted module to import.

The gate is tested by extracting its literal `run:` block from the workflow
source and executing it as `bash -e <file>` — what a `run:` with no
`shell:` gets on a Linux runner — under different FLOW_READY values, rather
than by pattern-matching the YAML text. A textual check can be satisfied by
a comparison that reads right and behaves differently (a case-insensitive
match, a truthy check); running the real script is the only way to pin the
behaviour rather than its spelling.

Running the script is necessary and not sufficient, though, and the second
half of this file is why. Whether the gate refuses a bad value and whether
the *job* stops are different questions, and everything that decides the
second one sits outside the script: what the step's `env:` binds FLOW_READY
to, an `if:` or `continue-on-error:` on the gate step OR on any step after
it, a `defaults: run: shell:` that replaces the interpreter, which job holds
the steps that create state, and what runs above the gate. Every one of
those was applied to provision-tenant.yml in a worktree and left every
behavioural assertion here green while the gate was, in effect, open. The
assertions that close them read the YAML around the step deliberately —
that surface has no runtime to execute.

Two consequences of reading YAML as text, both handled by refusing rather
than by skipping. A trailing `#` comment on a job key hid a whole second job
from an earlier version of this file; a step with no `name:` was invisible
to it entirely. `_job_names` and `_step_names` now raise on any line at the
right indent that they cannot read, so an unfamiliar YAML shape is a red
test rather than a silent gap. A real parse would be better still, but
PyYAML is not stdlib and the `Scripts unit tests` job installs no pip
dependencies — that trade-off is recorded here rather than left implicit.

## STEPS_ALLOWED_TO_SURVIVE_A_FAILED_PREDECESSOR

Steps allowed to carry `if:` or `continue-on-error:`. Either key lets a
step run, or survive, after the gate has already refused —
`if: always()` on the step that creates the tenant repository yields a red
run and a created tenant, which is the worst of both. The gate's own
`exit 1` stops the job only because every step after it is conditional on
its success by default.

`Summary` is the one exception and creates nothing. It is listed rather
than pattern-matched because the idiom is already live in this workflow,
several hundred lines below the steps where the same line would be a
disaster, and one copy-paste is all it takes.

## _run_gate

Execute the gate's actual extracted shell against a FLOW_READY value.

Returns (returncode, combined stdout+stderr). `unset=True` deletes the
variable from the environment entirely, rather than setting it to "" —
the workflow's own `${{ vars.X }}` expands an unset repository variable
to the empty string, so this is exercised as its own case rather than
assumed identical.

Run as `bash -e <file>`, which is what a `run:` block with no `shell:`
key gets on a Linux runner (`bash -e {0}`). `bash -c <string>` differs
on exactly the point this gate is about — an unchecked command failing
part-way through — and this step is the only `run:` block in the
workflow that does not set `-euo pipefail` for itself.

## TheGateExistsAndRunsFirst

Two assertions about position, because neither is sufficient alone.

The workflow's own comment on the step immediately after the gate says
moving the credential-free checkout earlier "changes nothing about what
'before anything is created' protects", and the tracked item draws the
same line: reordering past checkout, credential-scoping or validation is
survivable, only reordering past the first state-creating step is not.

So the documented flexibility is preserved — but as an explicit
allowlist, not as a blanket "anything may precede the gate as long as
the gate precedes one particular named step further down". That weaker
reading was the shape this file shipped with, and a step running
`gh repo create` inserted at the very top of the job satisfied it. Both
lists are named constants at the top of this file; moving `Checkout`
above the gate is now a two-line change (the workflow, and
STEPS_ALLOWED_BEFORE_THE_GATE) rather than a silent one.

## test_no_defaults_block_can_replace_the_shell_that_runs_the_gate

`defaults: run: shell:` at workflow or job level substitutes the
command every `run:` block is handed to, the gate's included.

A custom shell is `command [options] {0}`, so a `shell:` that never
reaches `{0}` — or reaches it as an argument rather than a script —
neutralises every step in the job at once while leaving each one's
text untouched. This workflow declares no `defaults:` at either
level today; the effect is reasoned from GitHub's documented
substitution rather than observed on a runner, which is why the
assertion is the conservative one: no `defaults:` at all, rather
than an attempt to judge a particular shell string safe.
