#!/usr/bin/env python3
"""Pin tests for how the hosts and demo-host applies are routed by the spend gate.

Text checks of the two workflows, and a replay of their steps on a stub `gh`."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

# The reviewer App's integration id, as `app.id` on the live rule object.
REVIEWER_APP_ID = 5090756
SPEND_GATE_SHA = "10b735392df0f32742c0f322b666c2c7249b782c"
SPEND_GATE_USES = re.compile(r"uses: branchLeft/github-workflows/\.github/actions/spend-gate@([0-9a-f]{40}) #")

FREE = "production-free"
READY_NAME = "Check the free apply environment is gated"
ROUTE_NAME = "Choose the apply environment"
SPEND_NAME = "Decide whether the plan could cost money"
GATE_NAME = "Refuse to apply through an ungated environment"
REGATE_NAME = "Refuse a plan that could cost money on the free environment"


class Stack:
    def __init__(self, key, workflow, owner_environment, plan_name, apply_name, delete_noun, directory):
        self.key = key
        self.path = WORKFLOWS / workflow
        self.owner = owner_environment
        self.plan_name = plan_name
        self.apply_name = apply_name
        self.delete_plan = "Refuse a plan that destroys the %s" % delete_noun
        self.delete_apply = "Refuse to apply a plan that destroys the %s" % delete_noun
        self.directory = directory

    @property
    def routed(self):
        return (
            "${{ needs.plan.outputs.apply_environment == 'production-free' "
            "&& 'production-free' || '%s' }}" % self.owner
        )

    def text(self):
        return self.path.read_text(encoding="utf-8")


STACKS = (
    Stack("hosts", "infra-hosts-ci.yml", "production",
          "Plan (hosts, pulumi preview)", "Apply (hosts, pulumi up)", "estate", "infra/hosts"),
    Stack("demo-host", "infra-demo-host-ci.yml", "production-demo-host",
          "Plan (demo host, pulumi preview)", "Apply (demo host, pulumi up)", "demo host", "infra/demo-host"),
)

# A stand-in for `gh api`: logs every call, answers from fixture files named by
# the environment, applies --jq with jq, and mimics gh's failure mode (the error
# body on stdout, a non-zero exit) when a fixture is absent.
STUB_GH = r"""#!/usr/bin/env bash
shift
method=GET
url=""
expr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --method) method="$2"; shift 2 ;;
    --jq) expr="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
echo "${method} ${url}" >> "${STUB_LOG}"
case "${url}" in
  *deployment_protection_rules*) file="${STUB_DIR}/rules.json" ;;
  */environments/*) file="${STUB_DIR}/environment.json" ;;
  *) file="" ;;
esac
if [ -z "${file}" ] || [ ! -f "${file}" ]; then
  echo '{"message":"Resource not accessible by integration","status":"403"}'
  exit 1
fi
if [ -n "${expr}" ]; then jq -r "${expr}" "${file}"; else cat "${file}"; fi
"""


def job_block(text: str, job: str) -> str:
    """The text of one top-level job: from its key to the next job key."""
    jobs = text.split("\njobs:\n", 1)[1]
    keys = list(re.finditer(r"^  ([A-Za-z0-9_-]+):[ \t]*$", jobs, re.M))
    for i, match in enumerate(keys):
        if match.group(1) == job:
            end = keys[i + 1].start() if i + 1 < len(keys) else len(jobs)
            return jobs[match.start():end]
    raise AssertionError("job %r not found" % job)


def step_blocks(job: str) -> list[tuple[str, str]]:
    """(name, text) for each step of a job, including its leading comments."""
    steps = job.split("\n    steps:\n", 1)[1]
    starts = [m.start() for m in re.finditer(r"^      - ", steps, re.M)]
    out = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(steps)
        text = steps[start:end]
        name = re.match(r"      - name: (.*)", text)
        out.append((name.group(1).strip() if name else "", text))
    return out


def step(job: str, name: str) -> str:
    found = [text for n, text in step_blocks(job) if n == name]
    if len(found) != 1:
        raise AssertionError("expected exactly one step %r, got %d" % (name, len(found)))
    return found[0]


def step_names(job: str) -> list[str]:
    return [n for n, _ in step_blocks(job)]


def run_script(step_text: str) -> str:
    """The `run: |` body of a step, dedented."""
    out, inside = [], False
    for line in step_text.split("\n"):
        if not inside:
            if line == "        run: |":
                inside = True
            continue
        if line.strip() and not line.startswith("          "):
            break
        out.append(line[10:] if line.strip() else "")
    if not out:
        raise AssertionError("step has no `run: |` body")
    return "\n".join(out) + "\n"


def environment_of(job: str):
    match = re.search(r"^    environment: (.+?)[ \t]*$", job, re.M)
    return match.group(1) if match else None


def job_env_value(job: str, name: str):
    match = re.search(r"^      %s: (.+?)[ \t]*$" % re.escape(name), job, re.M)
    return match.group(1) if match else None


def job_if(job: str) -> str:
    match = re.search(r"^    if: >-\n((?:      .*\n)+)", job, re.M)
    if match:
        return " ".join(line.strip() for line in match.group(1).splitlines())
    match = re.search(r"^    if: (.+)$", job, re.M)
    return match.group(1).strip() if match else ""


def resolve_environment(expression: str, owner: str, outputs: dict) -> str:
    """Evaluate a routed `environment:` value the way GitHub does, for the one
    shape the workflows use. Any other shape raises, so a rewrite of the
    expression cannot slip past the replay."""
    match = re.fullmatch(
        r"\$\{\{ needs\.([A-Za-z0-9_-]+)\.outputs\.apply_environment == 'production-free' "
        r"&& 'production-free' \|\| '" + re.escape(owner) + r"' \}\}",
        expression,
    )
    if not match:
        raise AssertionError("not the routed environment expression: %r" % expression)
    # `a == b && c || d` is `(a == b && c) || d`; c is a non-empty string.
    if outputs.get(match.group(1), "") == FREE:
        return FREE
    return owner


class StubGh:
    """A temp directory holding a stub `gh` on PATH and fixture files."""

    def __init__(self, testcase: unittest.TestCase):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="apply-env-test-"))
        testcase.addCleanup(shutil.rmtree, self.dir, True)
        gh = self.dir / "gh"
        gh.write_text(STUB_GH, encoding="utf-8")
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
        self.log = self.dir / "calls.log"
        self.log.write_text("", encoding="utf-8")

    def put(self, name: str, value) -> None:
        (self.dir / name).write_text(json.dumps(value), encoding="utf-8")

    def run(self, script: str, cwd: str, **env: str) -> subprocess.CompletedProcess:
        full = {
            "PATH": "%s%s%s" % (self.dir, os.pathsep, os.environ["PATH"]),
            "STUB_DIR": str(self.dir),
            "STUB_LOG": str(self.log),
            "GITHUB_REPOSITORY": "ORG/REPO",
            "GH_TOKEN": "TOKEN_PLACEHOLDER",
        }
        full.update(env)
        # GitHub runs `run:` bodies as `bash -e {0}`.
        return subprocess.run(["bash", "-e", "-c", script], env=full, cwd=cwd, capture_output=True,
                              text=True, check=False)

    def calls(self) -> list[str]:
        return self.log.read_text(encoding="utf-8").splitlines()


def environment_object(reviewers: bool) -> dict:
    rules = [{"id": 1, "type": "branch_policy"}]
    if reviewers:
        rules.append({"id": 2, "type": "required_reviewers", "reviewers": []})
    return {"name": "ENV", "protection_rules": rules}


def app_rule(enabled: bool = True, app_id: int = REVIEWER_APP_ID, slug: str = "branchleft-reviewer") -> dict:
    return {
        "total_count": 1,
        "custom_deployment_protection_rules": [
            {"id": 1, "enabled": enabled, "app": {"id": app_id, "slug": slug}}
        ],
    }



class StackChecks:
    """Mixed into one TestCase per stack, so a failure names its stack."""

    stack: Stack

    @property
    def text(self) -> str:
        return self.stack.text()

    @property
    def plan(self) -> str:
        return job_block(self.text, "plan")

    @property
    def apply_block(self) -> str:
        return job_block(self.text, "apply")


class RouteStructureChecks(StackChecks):
    def test_the_apply_uses_the_exact_routed_expression(self):
        self.assertEqual(environment_of(self.apply_block), self.stack.routed)

    def test_the_apply_environment_variable_is_the_same_expression(self):
        self.assertEqual(job_env_value(self.apply_block, "APPLY_ENVIRONMENT"), environment_of(self.apply_block))

    def test_the_other_jobs_are_never_routed(self):
        typecheck = job_block(self.text, "typecheck")
        self.assertNotIn("environment:", typecheck)
        self.assertNotIn("production-free", typecheck)
        self.assertNotIn("spend-gate", typecheck)

    def test_the_plan_publishes_the_route_step_output_next_to_the_no_op_verdict(self):
        self.assertIn("      has_changes: ${{ steps.noop.outputs.has_changes }}\n", self.plan)
        self.assertIn("      apply_environment: ${{ steps.route.outputs.environment }}\n", self.plan)

    def test_the_route_step_binds_exactly_the_four_inputs_and_the_owner_environment(self):
        body = step(self.plan, ROUTE_NAME)
        for binding in (
            "SPEND_VERDICT: ${{ steps.spend.outputs.verdict }}",
            "PREVIEW_OUTCOME: ${{ steps.preview.outcome }}",
            "DELETE_GUARD_OUTCOME: ${{ steps.deletes.outcome }}",
            "FREE_ENVIRONMENT_READY: ${{ steps.free_ready.outputs.ready }}",
        ):
            self.assertIn(binding, body)
        self.assertIn("id: route", body)
        # A fault here must not fail the plan: the output stays unset.
        self.assertIn("continue-on-error: true", body)
        self.assertIn("--owner-environment %s " % self.stack.owner, run_script(body))

    def test_the_ids_the_route_reads_belong_to_the_right_steps(self):
        self.assertIn("id: preview", step(self.plan, "Preview the plan"))
        self.assertIn("id: deletes", step(self.plan, self.stack.delete_plan))
        self.assertIn("id: spend", step(self.plan, SPEND_NAME))
        self.assertIn("id: free_ready", step(self.plan, READY_NAME))

    def test_the_routing_steps_run_after_the_delete_guard_and_before_the_summary(self):
        names = step_names(self.plan)
        order = [
            "Preview the plan",
            self.stack.delete_plan,
            SPEND_NAME,
            READY_NAME,
            ROUTE_NAME,
            "Decide whether the plan changes anything",
            "Write the plan to the job summary",
        ]
        positions = [names.index(n) for n in order]
        self.assertEqual(positions, sorted(positions))

    def test_the_spend_gate_step_is_advisory_to_the_plan_and_runs_only_after_success(self):
        body = step(self.plan, SPEND_NAME)
        self.assertIn("continue-on-error: true", body)
        # No `if:`: it takes the default success(), so a failed preview or
        # delete guard leaves its verdict unset.
        self.assertNotRegex(body, r"^        if:", "the gate must run only after success")
        self.assertIn("preview-json: preview.json", body)
        self.assertIn("working-directory: %s" % self.stack.directory, body)

    def test_the_gate_is_pinned_to_one_full_sha_in_both_jobs(self):
        found = SPEND_GATE_USES.findall(self.text)
        self.assertEqual(len(found), 2, "one use in the plan job, one in the apply job")
        self.assertEqual(set(found), {SPEND_GATE_SHA})

    def test_the_apply_re_gates_its_own_preview_before_pulumi_up(self):
        names = step_names(self.apply_block)
        order = ["Preview the plan", self.stack.delete_apply, SPEND_NAME, REGATE_NAME, "Apply"]
        positions = [names.index(n) for n in order]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(positions[3] + 1, positions[4], "nothing may sit between the re-gate and Apply")
        regate = step(self.apply_block, REGATE_NAME)
        self.assertNotRegex(regate, r"^        if:", "the re-gate must not be skippable")
        self.assertNotIn("continue-on-error", regate)
        self.assertIn("SPEND_VERDICT: ${{ steps.spend.outputs.verdict }}", regate)

    def test_the_apply_side_gate_cannot_block_the_owner_s_path(self):
        self.assertIn("continue-on-error: true", step(self.apply_block, SPEND_NAME))

    def test_the_free_readiness_step_reads_only_the_free_environment(self):
        body = run_script(step(self.plan, READY_NAME))
        self.assertIn("environments/production-free/deployment_protection_rules", body)
        self.assertIn(".app.id == %d" % REVIEWER_APP_ID, body)
        self.assertNotIn("required_reviewers", body)

    def test_the_ungated_environment_refusal_still_opens_the_apply_after_checkout(self):
        self.assertEqual(step_names(self.apply_block)[:2], ["Checkout", GATE_NAME])

    def test_the_no_op_gate_is_untouched(self):
        self.assertEqual(
            job_if(self.apply_block),
            "github.event_name == 'push' && github.ref == 'refs/heads/main' && "
            "needs.plan.outputs.has_changes != 'false'",
        )
        self.assertIn("needs: [plan]", self.apply_block)
        self.assertIn("id: noop", step(self.plan, "Decide whether the plan changes anything"))


class NamesTheApproverReadsChecks(StackChecks):
    """The workspace approver reads the hosts job and step names from a recorded
    copy of the hosts workflow; a rename here must be a visible edit there."""

    def test_the_job_and_step_names(self):
        self.assertIn("    name: %s\n" % self.stack.plan_name, self.plan)
        self.assertIn("    name: %s\n" % self.stack.apply_name, self.apply_block)
        for name in (self.stack.delete_plan, SPEND_NAME):
            self.assertIn(name, step_names(self.plan))


@unittest.skipUnless(shutil.which("jq"), "jq is needed to run the readiness step")
class RouteReplayChecks(StackChecks):
    """A dry replay of the chain the workflow runs, step by step, on a stub
    `gh`: readiness, the route, the environment expression, the apply's
    environment gate and its re-gate. Each test is one route."""

    def setUp(self):
        self.stub = StubGh(self)
        self.work = self.stub.dir
        (self.work / "preview.json").write_text("{}", encoding="utf-8")
        self.outputs = self.work / "github-output"
        self.summary = self.work / "github-summary"

    def run_step(self, script: str, **env: str) -> subprocess.CompletedProcess:
        return self.stub.run(
            script, cwd=str(ROOT), GITHUB_OUTPUT=str(self.outputs), GITHUB_STEP_SUMMARY=str(self.summary), **env
        )

    def output(self, key: str) -> str:
        if not self.outputs.exists():
            return ""
        for line in self.outputs.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name == key:
                return value
        return ""

    def route(self, *, verdict: str, preview="success", deletes="success", rules=None) -> str:
        """Run readiness then the route step; return the plan job's output as
        the job would publish it (empty when the step wrote nothing)."""
        self.outputs.write_text("", encoding="utf-8")
        if rules is not None:
            self.stub.put("rules.json", rules)
        ready = self.run_step(run_script(step(self.plan, READY_NAME)))
        self.assertEqual(ready.returncode, 0, ready.stderr)
        chosen = self.run_step(
            run_script(step(self.plan, ROUTE_NAME)),
            SPEND_VERDICT=verdict,
            PREVIEW_OUTCOME=preview,
            DELETE_GUARD_OUTCOME=deletes,
            FREE_ENVIRONMENT_READY=self.output("ready"),
        )
        self.assertEqual(chosen.returncode, 0, chosen.stderr)
        return self.output("environment")

    def environment_for(self, published: str) -> str:
        return resolve_environment(environment_of(self.apply_block), self.stack.owner, {"plan": published})

    def apply_gate(self, environment: str, *, reviewers=False, rules=None) -> int:
        self.stub.put("environment.json", environment_object(reviewers=reviewers))
        if rules is not None:
            self.stub.put("rules.json", rules)
        script = run_script(step(self.apply_block, GATE_NAME))
        return self.run_step(script, APPLY_ENVIRONMENT=environment).returncode

    def regate(self, environment: str, verdict: str) -> int:
        script = run_script(step(self.apply_block, REGATE_NAME))
        return self.stub.run(script, cwd=str(self.work), APPLY_ENVIRONMENT=environment, SPEND_VERDICT=verdict).returncode

    def test_free_plan_with_a_gated_free_environment_runs_in_production_free(self):
        published = self.route(verdict="FREE", rules=app_rule())
        self.assertEqual(published, FREE)
        environment = self.environment_for(published)
        self.assertEqual(environment, FREE)
        self.assertEqual(self.apply_gate(environment, rules=app_rule()), 0)
        self.assertEqual(self.regate(environment, "FREE"), 0)
        self.assertIn("GET repos/ORG/REPO/environments/production-free/deployment_protection_rules", self.stub.calls())

    def test_a_paid_plan_runs_in_the_owner_environment(self):
        published = self.route(verdict="PAID", rules=app_rule())
        self.assertEqual(published, self.stack.owner)
        self.assertEqual(self.environment_for(published), self.stack.owner)

    def test_a_plan_the_gate_could_not_read_runs_in_the_owner_environment(self):
        # The gate step failed or was skipped: its output is the empty string.
        published = self.route(verdict="", rules=app_rule())
        self.assertEqual(published, self.stack.owner)
        self.assertEqual(self.environment_for(published), self.stack.owner)

    def test_a_failed_preview_or_delete_guard_runs_in_the_owner_environment(self):
        for preview, deletes in (("failure", "success"), ("success", "failure"), ("skipped", "skipped")):
            published = self.route(verdict="FREE", preview=preview, deletes=deletes, rules=app_rule())
            self.assertEqual(published, self.stack.owner, (preview, deletes))

    def test_a_free_plan_with_no_free_environment_runs_in_the_owner_environment(self):
        # The environment is not created yet: the rules endpoint answers 403
        # (the stub's unreadable case), so readiness is false.
        (self.work / "rules.json").unlink(missing_ok=True)
        self.assertEqual(self.route(verdict="FREE"), self.stack.owner)

    def test_a_free_plan_whose_environment_lost_the_app_rule_runs_in_the_owner_environment(self):
        for rules in (app_rule(enabled=False), app_rule(app_id=REVIEWER_APP_ID + 1)):
            self.assertEqual(self.route(verdict="FREE", rules=rules), self.stack.owner)

    def test_the_apply_refuses_a_free_environment_that_lost_its_rule_after_routing(self):
        published = self.route(verdict="FREE", rules=app_rule())
        environment = self.environment_for(published)
        self.assertEqual(environment, FREE)
        self.assertEqual(self.apply_gate(environment, rules=app_rule(enabled=False)), 1)

    def test_the_apply_refuses_a_plan_that_turned_paid_after_routing(self):
        for verdict in ("PAID", "", "free", "FREE\n"):
            self.assertEqual(self.regate(FREE, verdict), 1, verdict)

    def test_the_apply_in_the_owner_environment_is_not_blocked_by_the_gate(self):
        for verdict in ("FREE", "PAID", ""):
            self.assertEqual(self.regate(self.stack.owner, verdict), 0, verdict)

    def test_an_unknown_environment_name_is_refused_by_both_apply_steps(self):
        other = "production-demo-host" if self.stack.owner == "production" else "production"
        for name in ("", "production-mail", "production-free ", "staging", "Production", other):
            self.assertEqual(self.apply_gate(name, reviewers=True, rules=app_rule()), 1, name)
            self.assertEqual(self.regate(name, "FREE"), 1, name)

    def test_the_apply_gate_still_refuses_an_environment_with_no_rule_at_all(self):
        no_rules = {"total_count": 0, "custom_deployment_protection_rules": []}
        for name in (self.stack.owner, FREE):
            self.assertEqual(self.apply_gate(name, reviewers=False, rules=no_rules), 1, name)
            self.assertEqual(self.apply_gate(name, reviewers=True, rules=no_rules), 0, name)

    def test_the_apply_gate_reads_the_environment_it_runs_in(self):
        self.apply_gate(self.stack.owner, reviewers=True, rules=app_rule())
        self.apply_gate(FREE, rules=app_rule())
        calls = self.stub.calls()
        self.assertIn("GET repos/ORG/REPO/environments/%s" % self.stack.owner, calls)
        self.assertIn("GET repos/ORG/REPO/environments/production-free", calls)

    def test_only_the_exact_published_string_selects_the_free_environment(self):
        owner = self.stack.owner
        for published, expected in (
            (FREE, FREE),
            (owner, owner),
            ("", owner),
            ("PRODUCTION-FREE", owner),
            ("production-free ", owner),
            ("production-free-2", owner),
            ("true", owner),
        ):
            with self.subTest(published=published):
                self.assertEqual(self.environment_for(published), expected)
        # A plan job that published nothing at all (skipped or failed).
        self.assertEqual(resolve_environment(self.stack.routed, owner, {}), owner)


def _per_stack(checks, label):
    for stack in STACKS:
        name = "%s%s" % (stack.key.title().replace("-", ""), label)
        globals()[name] = type(name, (checks, unittest.TestCase), {"stack": stack})


_per_stack(RouteStructureChecks, "RouteStructureTests")
_per_stack(NamesTheApproverReadsChecks, "NamesTheApproverReadsTests")
_per_stack(RouteReplayChecks, "RouteReplayTests")


if __name__ == "__main__":
    unittest.main()
