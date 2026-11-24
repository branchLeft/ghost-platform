"""Proof that .github/CODEOWNERS owns only guardrails and human-facing documents.

The rule (an owner ruling): the owner is a required
reviewer only for (a) a file whose silent weakening would stop an agent
guardrail or a required check protecting us, and (b) documents written for other
people. Everything else lands on an agent review and green CI.

Run from infra/provisioning. CODEOWNERS_FILE names another file to check.
"""

from __future__ import annotations

import os
import pathlib
import posixpath
import re
import sys
import unittest
from dataclasses import dataclass
from typing import Optional, Sequence

from test_check_private_tenant_plan import OWNER, SYNC_TAIL

SCRIPTS = pathlib.Path(__file__).resolve().parent
REPO = SCRIPTS.parents[2]
CODEOWNERS_FILE = pathlib.Path(
    os.environ.get("CODEOWNERS_FILE") or REPO / ".github" / "CODEOWNERS"
)


# ---------------------------------------------------------------------------
# CODEOWNERS matcher
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Rule:
    pattern: str
    regex: "re.Pattern[str]"
    dir_only: bool
    owned: bool
    line: int


def _compile(pattern: str) -> tuple["re.Pattern[str]", bool]:
    dir_only = pattern.endswith("/")
    body = pattern.rstrip("/") if dir_only else pattern
    anchored = body.startswith("/")
    if anchored:
        body = body[1:]
    segments = body.split("/")
    anchored = anchored or len(segments) > 1
    out: list[str] = [] if anchored else ["(?:[^/]+/)*"]
    for index, segment in enumerate(segments):
        last = index == len(segments) - 1
        if segment == "**":
            out.append(".+" if last else "(?:[^/]+/)*")
            continue
        out.append(
            "".join(
                "[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c)
                for c in segment
            )
        )
        if not last:
            out.append("/")
    return re.compile("".join(out)), dir_only


def parse_codeowners(text: str) -> list[Rule]:
    rules: list[Rule] = []
    for number, raw in enumerate(text.splitlines(), 1):
        parts = raw.split()
        if not parts or parts[0].startswith("#"):
            continue
        regex, dir_only = _compile(parts[0])
        rules.append(Rule(parts[0], regex, dir_only, len(parts) > 1, number))
    return rules


def _matches(rule: Rule, path: str) -> bool:
    parts = path.split("/")
    if not rule.dir_only and rule.regex.fullmatch(path):
        return True
    # A directory that matches owns everything beneath it.
    return any(
        rule.regex.fullmatch("/".join(parts[:i])) for i in range(1, len(parts))
    )


def owning_rule(rules: Sequence[Rule], path: str) -> Optional[Rule]:
    """The rule that owns the path, or None when the last match names no owner."""
    found: Optional[Rule] = None
    for rule in rules:
        if _matches(rule, path):
            found = rule
    return found if found is not None and found.owned else None


def load_rules(path: pathlib.Path = CODEOWNERS_FILE) -> list[Rule]:
    return parse_codeowners(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# The sample table: (path, is it owned, why)
# ---------------------------------------------------------------------------

SAMPLES: tuple[tuple[str, bool, str], ...] = (
    # (a) Guardrails: owned.
    (".github/CODEOWNERS", True, "this file"),
    ("infra/provisioning/scripts/test_codeowners_ownership.py", True, "proof of this file"),
    ("infra/provisioning/scripts/test_check_private_tenant_plan.py", True, "asserts the SYNC-1 tail"),
    ("CLAUDE.md", True, "agent rules"),
    ("AUTHORISATIONS.md", True, "never-list"),
    (".claude/settings.json", True, "hooks and settings"),
    (".claude/hooks/guard.py", True, "hooks"),
    (".github/workflows/build.yml", True, "required check: docker build"),
    (".github/workflows/infra-tenant-ci.yml", True, "required check: Tenant type check"),
    (".github/workflows/repo-tooling-ci.yml", True, "required check: Format and lint"),
    (".github/workflows/digest-line-scope.yml", True, "required check: Digest-only line scope"),
    (".github/workflows/standards.yml", True, "required check (SYNC-1 tail)"),
    (".github/workflows/docs-lint.yml", True, "required check (SYNC-1 tail)"),
    (".github/actions/setup-pnpm-node/action.yml", True, "action the required checks call"),
    (".github/workflows/infra-hosts-ci.yml", True, "environment-gated apply"),
    (".github/workflows/provision-tenant.yml", True, "environment-gated provisioning"),
    (".github/workflows/promote-candidate.yml", True, "signs the promotion attestation"),
    (".github/workflows/registry-push.yml", True, "scans and attests the tenant image"),
    (".github/workflows/odask-image.yml", True, "image workflow (*-image.yml)"),
    (".github/workflows/publish-ring-controller.yml", True, "package publish (publish-*.yml)"),
    (".github/workflows/broker-release.yml", True, "attested release"),
    (".standardsignore", True, "escape hatch"),
    (".standards.mode", True, "escape hatch"),
    (".docs-lint.mode", True, "escape hatch"),
    (".standards-db-tooling", True, "escape hatch"),
    ("infra/provisioning/scripts/tenant-default-branch-ruleset.json", True, "ruleset"),
    ("tools/floors.tsv", True, "gate floors"),
    ("services/broker/vitest.config.ts", True, "coverage floor"),
    ("eslint.config.js", True, "lint gate"),
    (".pre-commit-config.yaml", True, "hook gate"),
    (".image-scan-exemptions.json", True, "scan exemption"),
    ("gate-set/gates.mjs", True, "gate set"),
    ("gate-set/test_node_env_gate.py", True, "gate test"),
    ("promote/verify-promotion.mjs", True, "promotion attestation"),
    ("csp/gate/csp-regression-gate.mjs", True, "content-policy gate"),
    ("csp/proof/inject-attack.mjs", True, "attack harness the gate runs"),
    ("widgets/pins.json", True, "integrity pin"),
    ("vendor/kalotyp/kalotyp.sha256", True, "integrity pin"),
    ("adapters/scanning-storage/ghost-core-overlay/theme-storage.js", True, "gate-set pinned file"),
    ("adapters/scanning-storage/test/fixtures/bad.png", True, "fixture of a gate"),
    ("themes/manifest.json", True, "theme list the scan gate iterates"),
    ("digest-line-scope.test.js", True, "root workflow guard test"),
    ("scripts/digest-line-scope.js", True, "merge gate"),
    ("scripts/assert-image-refs-on-mirror.py", True, "image gate"),
    ("scripts/verify-image-attestation.sh", True, "attestation verifier"),
    ("scripts/demo-edge-pins.mjs", True, "gate that decides a push"),
    ("scripts/test_workflow_permissions.py", True, "required check"),
    ("scripts/test_apply_gate_operands.py", True, "required check"),
    ("scripts/test_image_mirror.py", True, "test of a kept gate"),
    ("infra/scripts/choose-apply-environment.py", True, "deploy gate"),
    ("infra/scripts/assert-no-hetzner-deletes.py", True, "deploy gate"),
    ("infra/scripts/fixtures/choose-apply-environment/spend-server-create.output", True, "fixture of a gate"),
    ("infra/tenant/scripts/assert-no-tenant-deletes.py", True, "deletes guard"),
    ("infra/provisioning/scripts/assert-image-ref.py", True, "provisioning gate"),
    ("infra/provisioning/scripts/test_assert_image_ref.py", True, "test of a kept gate"),
    ("infra/provisioning/scripts/check_private_tenant_plan.py", True, "approval gate"),
    ("registers/private-tenant-plan.json", True, "owner's approval register"),
    ("registers/tenant-names.json", True, "gate input of provision-tenant.yml"),
    # Credentialed or write-permission workflows, and what they run by path.
    (".github/workflows/codeql.yml", True, "grants a write permission"),
    (".github/workflows/generate-lockfile.yml", True, "writes contents, refuses main"),
    (".github/workflows/image-mirror.yml", True, "writes packages"),
    (".github/workflows/major-watcher-run.yml", True, "holds a secret and writes"),
    (".github/workflows/release-watcher-run.yml", True, "holds a secret and writes"),
    (".github/image-mirror/images.json", True, "list the credentialed mirror reads"),
    (".github/image-mirror/private-packages.json", True, "list the credentialed probe reads"),
    ("scripts/mirror-images.py", True, "run by the credentialed mirror"),
    ("scripts/probe_private_packages.py", True, "run by the mirror workflow"),
    ("scripts/test_probe_private_packages.py", True, "test of a kept gate"),
    # (b) Human-facing documents: owned.
    ("README.md", True, "top-level document"),
    ("CONTRIBUTING.md", True, "top-level document"),
    ("LICENSE", True, "legal text"),
    ("render-core/LICENSE", True, "legal text"),
    ("portal/apps/src/tenant/explainerPages.ts", True, "product copy"),
    # Released: trust extended to agents on sensitive code.
    (".github/workflows/broker-ci.yml", False, "component CI, not required"),
    (".github/workflows/mail-gate-ci.yml", False, "component CI, not required"),
    (".github/workflows/gate-set-ci.yml", False, "CI of a gate, not required"),
    (".github/workflows/provisioning-gate-watch.yml", False, "scheduled monitor"),
    (".github/dependabot.yml", False, "update settings"),
    ("Dockerfile", False, "image build"),
    ("portal/Dockerfile", False, "image build"),
    ("services/mail-collector/Dockerfile", False, "image build"),
    (".dockerignore", False, "image build"),
    ("docker-entrypoint.branchleft.sh", False, "image entrypoint"),
    ("package.json", False, "dependencies"),
    ("services/broker/package.json", False, "dependencies"),
    ("infra/tenant/pnpm-workspace.yaml", False, "dependencies"),
    ("services/broker/pnpm-lock.yaml", False, "lockfile"),
    (".npmrc", False, "package manager config"),
    (".nvmrc", False, "version pin"),
    (".gitignore", False, "ignore list"),
    ("services/broker/src/auth.ts", False, "auth code"),
    ("services/broker/test/unit/auth.test.ts", False, "test"),
    ("services/broker/src/signedRequestScheme.ts", False, "broker code"),
    ("services/broker/release/check_release_tag.py", False, "release code"),
    ("services/storage-gateway/src/credentials/masterSecret.ts", False, "secrets handling code"),
    ("services/release-classifier/src/gate.mjs", True, "feeds the signed promotion attestation"),
    ("services/release-classifier/test/gate.test.mjs", True, "proof of the gate"),
    ("services/ring-controller/src/gates.ts", True, "upgrade gate"),
    ("services/ring-controller/src/ringController.ts", True, "upgrade gate"),
    ("services/ring-controller/test/unit/ringControllerSabotage.test.ts", True, "sabotage proof of the gate"),
    ("themes/verify.mjs", True, "theme scan run by the image build"),
    ("services/ring-controller/src/README.md", False, "engineering doc"),
    ("services/release-watcher/release_watcher/merge.py", False, "app code"),
    ("adapters/sso/src/break-glass.js", False, "app code"),
    ("services/demo-edge/Dockerfile", False, "edge image"),
    ("csp/derive/derive-script-hashes.mjs", False, "generator"),
    ("scripts/mail-gate/mail-gate.mjs", True, "run by the gate set"),
    ("scripts/test-storage-guard.sh", True, "run by the gate set"),
    ("scripts/smoke-test.sh", True, "run by the gate set"),
    ("scripts/json.py", False, "tooling"),
    ("scripts/mollie-test-charge.py", False, "tooling"),
    ("db/provision/provision_tenant_db.py", False, "db grants code"),
    ("db/provision/prune_backups.py", False, "backup code"),
    ("db/stack/conf.d/branchleft.cnf", False, "database config"),
    ("db/percona/smoke_check.py", False, "image code"),
    ("demo-host/provision/render_slot_sudoers.py", False, "host code"),
    ("infra/hosts/index.ts", False, "Pulumi program"),
    ("infra/hosts/Pulumi.production.yaml", False, "stack config"),
    ("infra/demo-host/index.ts", False, "Pulumi program"),
    ("infra/provisioning/host-key-register.txt", False, "host-key register"),
    ("infra/provisioning/escrow/tenant-passphrase-escrow.pub.pem", False, "escrow key"),
    ("infra/provisioning/scripts/scratch_preflight.py", False, "tooling"),
    ("control/provision/branchleft-backup-worker.timer", False, "host unit"),
    ("app/provision/render_tenant_secrets.py", False, "host code"),
    ("test-support/ghost-container.mjs", False, "test support"),
    ("themes/image/themes.image.test.mjs", False, "test"),
    ("adapters/sso/test/helpers/token.mjs", False, "test helper"),
    ("services/broker/README.md", False, "engineering doc"),
    ("db/README.md", False, "engineering doc"),
    ("db/RUNBOOK-db.md", False, "runbook"),
    ("RUNBOOK-tenant-onboarding.md", False, "runbook"),
    ("services/ring-controller/README.md", False, "engineering doc"),
    ("infra/provisioning/scripts/restore_drill.md", False, "engineering doc"),
)




_GATE_PIN = re.compile(r"""\b(?:repoFile|pin):\s*['"]([^'"]+)['"]""")
_GATE_AT = re.compile(r"\bat\(((?:\s*['\"][^'\"]+['\"]\s*,?)+)\)")


def gate_set_reads(gates_source: str) -> list[str]:
    """Repository files that gate-set/gates.mjs names: the pins and the files its gates run."""
    found: list[str] = _GATE_PIN.findall(gates_source)
    for call in _GATE_AT.findall(gates_source):
        path = "/".join(re.findall(r"""['"]([^'"]+)['"]""", call))
        if "." in posixpath.basename(path):  # a file, not a working directory
            found.append(path)
    return sorted(set(found))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class CodeownersCase(unittest.TestCase):
    rules: list[Rule]

    @classmethod
    def setUpClass(cls) -> None:
        cls.rules = load_rules()


class OwnsTheSamples(CodeownersCase):
    def test_every_sample_is_owned_or_released_as_expected(self) -> None:
        wrong: list[str] = []
        for path, owned, why in SAMPLES:
            got = owning_rule(self.rules, path) is not None
            if got != owned:
                wrong.append(
                    f"{path}: want {'owned' if owned else 'unowned'}, got "
                    f"{'owned' if got else 'unowned'} ({why})"
                )
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))

    def test_the_table_has_a_sample_for_each_kept_and_each_released_class(self) -> None:
        self.assertGreaterEqual(sum(1 for _, o, _ in SAMPLES if o), 45)
        self.assertGreaterEqual(sum(1 for _, o, _ in SAMPLES if not o), 35)
        self.assertEqual(len({p for p, _, _ in SAMPLES}), len(SAMPLES), "a path is listed twice")

    def test_every_owned_line_names_the_one_owner_and_there_is_no_catch_all(self) -> None:
        for raw in CODEOWNERS_FILE.read_text(encoding="utf-8").splitlines():
            parts = raw.split()
            if not parts or parts[0].startswith("#"):
                continue
            with self.subTest(line=raw):
                self.assertNotIn(parts[0], ("*", "/*", "**", "/**"), "a catch-all line")
                self.assertIn(len(parts), (1, 2), "a line names one owner or none")
                if len(parts) == 2:
                    self.assertEqual(parts[1], OWNER)

    def test_the_standards_template_paths_are_owned(self) -> None:
        for pattern in SYNC_TAIL:
            sample = pattern.replace("*", "x").lstrip("/")
            if sample.endswith("/"):
                sample += "file"
            with self.subTest(pattern=pattern):
                self.assertIsNotNone(owning_rule(self.rules, sample))


_DEPLOY_GATE_MARKERS = (
    re.compile(r"^\s+environment:", re.MULTILINE),
    re.compile(r"attest-and-verify-image|attest-build-provenance|actions/attest"),
)
_REQUIRED_JOB_NAMES = (
    "docker build",
    "Tenant type check",
    "Format and lint",
    "Digest-only line scope",
)


class GateWorkflowsKeepTheirOwner(CodeownersCase):
    """A workflow that gates a deploy or emits a required check must stay owned.

    The sample table names examples; this reads every workflow, so a new one that
    adds an environment gate, an attestation or a required job name cannot be
    released by a name the lines above do not match.
    """

    def _workflows(self) -> list[pathlib.Path]:
        found = sorted((REPO / ".github" / "workflows").glob("*.yml"))
        self.assertGreater(len(found), 10, "no workflows found to check")
        return found

    def test_every_environment_gated_or_attesting_workflow_is_owned(self) -> None:
        unowned = [
            f".github/workflows/{path.name}"
            for path in self._workflows()
            if any(m.search(path.read_text(encoding="utf-8")) for m in _DEPLOY_GATE_MARKERS)
            and owning_rule(self.rules, f".github/workflows/{path.name}") is None
        ]
        self.assertEqual(
            unowned,
            [],
            "\nThese workflows hold an environment gate or sign an attestation, so a "
            "change to one can weaken a deploy gate. Own them:\n" + "\n".join(unowned),
        )

    def test_every_required_check_is_emitted_by_an_owned_workflow(self) -> None:
        for name in _REQUIRED_JOB_NAMES:
            emitters = [
                path.name
                for path in self._workflows()
                if re.search(rf"^    name: {re.escape(name)}\s*$", path.read_text(encoding="utf-8"), re.MULTILINE)
            ]
            with self.subTest(check=name):
                self.assertTrue(emitters, f"no workflow emits the required check {name!r}")
                for workflow in emitters:
                    self.assertIsNotNone(
                        owning_rule(self.rules, f".github/workflows/{workflow}"),
                        f"{workflow} emits the required check {name!r} and is not owned",
                    )


def hold_reasons(text: str, is_action: bool) -> list[str]:
    """Why a workflow or action file stays owned, read from its own text.

    A file stays owned when it names a secret other than GITHUB_TOKEN, carries
    an environment, grants any write permission, has no explicit permissions
    block, or declares secrets on workflow_call.
    """
    out: list[str] = []
    if (
        re.search(r"(?<![\w-])secrets\.(?!GITHUB_TOKEN\b)[A-Za-z_]", text)
        or re.search(r"(?<![\w-])secrets\[", text)
        or re.search(r"secrets:\s*inherit", text)
    ):
        out.append("secrets")
    if re.search(r"^\s+environment:", text, re.M):
        out.append("environment")
    if re.search(r"^\s+[a-z-]+:\s*write\s*(#.*)?$", text, re.M) or re.search(
        r"permissions:\s*write-all", text
    ):
        out.append("write permission")
    if re.search(r"workflow_call:", text) and re.search(r"^\s{4}secrets:\s*$", text, re.M):
        out.append("workflow_call secrets")
    if not is_action and not re.search(r"^permissions:", text, re.M):
        start = re.search(r"^jobs:\s*$", text, re.M)
        body = text[start.end() :] if start else ""
        pattern = r"^  (?=[A-Za-z0-9_.-]+:\s*(?:#.*)?$)"
        jobs = re.split(pattern, body, flags=re.M)[1:]
        if not jobs or any(not re.search(r"^    permissions:", job, re.M) for job in jobs):
            out.append("no permissions block")
    return out


class WorkflowsHeldByTheRule(CodeownersCase):
    """Every workflow or local action that matches the hold rule must be owned."""

    def test_the_rule_reads_the_cases_it_names(self) -> None:
        cases = {
            "a secret": ("env:\n  T: ${{ secrets.TOKEN }}\n", "secrets"),
            "an environment": ("jobs:\n  a:\n    environment: prod\n", "environment"),
            "a write": ("permissions:\n  contents: write\n", "write permission"),
            "no block": ("on: push\njobs:\n  a:\n    runs-on: x\n", "no permissions block"),
        }
        for name, (text, reason) in cases.items():
            with self.subTest(case=name):
                self.assertIn(reason, hold_reasons(text, False))
        plain = "env:\n  T: ${{ secrets.GITHUB_TOKEN }}\npermissions: {}\n"
        self.assertEqual(hold_reasons(plain, False), [])

    def test_every_matching_workflow_is_owned(self) -> None:
        files = sorted((REPO / ".github" / "workflows").glob("*.y*ml"))
        files += sorted((REPO / ".github" / "actions").glob("*/action.y*ml"))
        self.assertGreater(len(files), 10, "no workflows found to check")
        unowned: list[str] = []
        for file in files:
            rel = file.relative_to(REPO).as_posix()
            reasons = hold_reasons(file.read_text(encoding="utf-8"), "/actions/" in rel)
            if reasons and owning_rule(self.rules, rel) is None:
                unowned.append(f"{rel} ({', '.join(reasons)})")
        self.assertEqual(
            unowned,
            [],
            "\nThese workflows match the hold rule, so they stay owned:\n" + "\n".join(unowned),
        )

    def test_no_script_shadows_the_standard_library(self) -> None:
        """The mirror runs `python3 scripts/<name>.py`, which puts scripts/ first on
        the import path: a new scripts/json.py would be imported by the credentialed
        job in place of the standard module. No such file may exist."""
        shadows = sorted(
            path.name
            for path in (REPO / "scripts").glob("*.py")
            if path.stem in sys.stdlib_module_names
        )
        self.assertEqual(shadows, [])


class GateSetFilesKeepTheirOwner(CodeownersCase):
    def test_the_reader_finds_a_pinned_file_and_a_file_the_gate_runs(self) -> None:
        source = (
            "{ repoFile: 'a/b.js' }, { pin: 'c/d.sha256' }, "
            "exec(['sh', at('scripts', 'e.sh'), image], { cwd: at('adapters', 'x') })"
        )
        self.assertEqual(gate_set_reads(source), ["a/b.js", "c/d.sha256", "scripts/e.sh"])

    def test_every_file_the_gate_set_pins_or_runs_is_owned(self) -> None:
        source = (REPO / "gate-set" / "gates.mjs").read_text(encoding="utf-8")
        named = gate_set_reads(source)
        self.assertIn("adapters/scanning-storage/ghost-core-overlay/theme-storage.js", named)
        unowned = [p for p in named if owning_rule(self.rules, p) is None]
        self.assertEqual(
            unowned,
            [],
            "\nThe gate set pins or runs these files, so an edit to one changes what the "
            "gate calls green (criterion 1). Keep them owned:\n" + "\n".join(unowned),
        )



if __name__ == "__main__":
    unittest.main()
