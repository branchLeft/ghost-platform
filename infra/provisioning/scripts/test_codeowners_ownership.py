"""Proof that .github/CODEOWNERS still owns what the owner's review criteria name.

CODEOWNERS is the owner's gate: a pull request that touches an owned path needs
the owner's review, and one that touches none merges on the reviewer App's
approval. A wrong line removes a control without any error, so this module
answers two questions from the files themselves.

OwnsTheSamples: for a fixed table of paths, one or more per kept criterion and
per released class, does the file own the path or not. The matcher follows
GitHub's rules: the last matching line wins, an unrooted name matches at any
depth, a matching directory owns what is beneath it, and a line with no owner
releases the path.

SecretBearingJobsOwnTheirInputs: every file a workflow job that holds a secret
(or feeds one) executes must be owned, because an edited script or manifest
there reaches a token the pull request itself never sees. The workflows are read
from the checkout with the standard library only. A job holds a secret when it
declares a write permission, names an environment, references a secret other
than the read GITHUB_TOKEN, or declares no permissions at all: the repository's
default workflow token is write, so a job with no permissions block at workflow
or job level holds a write token. A workflow this module cannot parse fails
closed, naming the file.

CODEOWNERS_FILE names another file to check (the default is the repository's),
which is how the red result on an older file is produced:

    git show origin/main:.github/CODEOWNERS > "$TMP/old"
    CODEOWNERS_FILE="$TMP/old" python3 -m unittest discover -s scripts \\
        -p test_codeowners_ownership.py -v

Run from infra/provisioning, where CI runs the suite.
"""

from __future__ import annotations

import json
import os
import pathlib
import posixpath
import re
import unittest
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator, Mapping, Optional, Sequence

from test_check_private_tenant_plan import OWNER, SYNC_TAIL

SCRIPTS = pathlib.Path(__file__).resolve().parent
REPO = SCRIPTS.parents[2]
CODEOWNERS_FILE = pathlib.Path(
    os.environ.get("CODEOWNERS_FILE") or REPO / ".github" / "CODEOWNERS"
)

# The repository's default workflow token. Read it from the settings with
# `gh api repos/<owner>/<repo>/actions/permissions/workflow`
# (default_workflow_permissions). While it is "write", a job with no
# `permissions` block at workflow or job level holds a write token. Set this to
# False only after the setting is changed to read.
REPO_DEFAULT_TOKEN_IS_WRITE = True

CODE_SUFFIXES = (".py", ".sh", ".mjs", ".js", ".cjs", ".ts", ".tsx")
MANIFEST_NAMES = ("package.json", "pnpm-workspace.yaml", ".npmrc")

# A job whose package directory is chosen at run time cannot be read from its
# YAML. Name the directory patterns it may take, per workflow file, so the
# manifests there are checked. An empty tuple says the directory is not in the
# repository (a runner temp path).
DYNAMIC_PACKAGE_DIRS: Mapping[str, tuple[str, ...]] = {
    # generate-lockfile.yml accepts exactly services/<name> and adapters/<name>.
    "generate-lockfile.yml": ("services/*", "adapters/*"),
    "release-watcher-run.yml": (),
}


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
# The sample table: (path, is it owned, why)
# ---------------------------------------------------------------------------

SAMPLES: tuple[tuple[str, bool, str], ...] = (
    # Criterion 1: the rules, the gates, the floors and the exemptions.
    ("gate-set/gates.mjs", True, "c1 gate set"),
    ("csp/gate/csp-regression-gate.mjs", True, "c1 csp gate"),
    ("scripts/digest-line-scope.js", True, "c1 merge gate"),
    ("digest-line-scope.test.js", True, "c1 root workflow guard test"),
    ("scripts/assert-image-refs-on-mirror.py", True, "c1 image gate"),
    ("scripts/verify-image-attestation.sh", True, "c1 verifier"),
    ("scripts/demo-edge-pins.mjs", True, "c1 gate that decides a push"),
    ("scripts/test-drain-sidecar.sh", True, "c1 gate in a job that feeds a push"),
    ("infra/scripts/choose-apply-environment.py", True, "c1 deploy gate"),
    ("infra/scripts/test_choose_apply_environment.py", True, "c1 test of a kept gate"),
    (
        "infra/scripts/fixtures/choose-apply-environment/spend-server-create.output",
        True,
        "c1 fixture of a kept gate",
    ),
    ("infra/tenant/scripts/assert-no-tenant-deletes.py", True, "c1 deletes guard"),
    ("services/release-classifier/src/gate.mjs", True, "c1 upgrade gate"),
    ("services/ring-controller/src/ringController.ts", True, "c1 upgrade gate"),
    (
        "services/release-watcher/release_watcher/merge.py",
        True,
        "c1 merge bot holding an App key",
    ),
    (".image-scan-exemptions.json", True, "c1 exemption file"),
    ("services/broker/vitest.config.ts", True, "c1 coverage floor"),
    (".standardsignore", True, "c1 escape hatch"),
    (".github/CODEOWNERS", True, "c1 this file"),
    ("widgets/pins.json", True, "c1 integrity pin"),
    ("vendor/kalotyp/kalotyp.sha256", True, "c1 integrity pin"),
    # Criteria 2 and 3: programs and inputs a secret-bearing job runs.
    ("scripts/mirror-images.py", True, "image-mirror.yml mirror, packages write"),
    ("scripts/probe_private_packages.py", True, "image-mirror.yml mirror"),
    ("scripts/smoke-test.sh", True, "registry-push.yml push, packages write"),
    ("scripts/test-storage-guard.sh", True, "registry-push.yml push"),
    ("scripts/mail-gate/mail-gate.mjs", True, "registry-push.yml push"),
    ("scripts/mollie-test-charge.py", True, "protected environment"),
    ("scripts/test_mollie_test_charge.py", True, "protected environment"),
    ("scripts/assert-lockfile-package-dir.py", True, "gates a lockfile write"),
    ("scripts/assert-broker-contract-generated.py", True, "speckify.yml writes"),
    ("services/broker/release/check_release_tag.py", True, "broker-release.yml release"),
    ("services/broker/release/pack-release.sh", True, "broker-release.yml build feeds release"),
    ("services/broker/esbuild.bundle.mjs", True, "bundle step of the job that feeds release"),
    ("db/percona/smoke_check.py", True, "percona-image.yml push"),
    ("db/recovery/check_toolchain_version.py", True, "recovery-image.yml push"),
    (
        "infra/provisioning/scripts/tenant_provisioning_app_token.py",
        True,
        "provision-tenant.yml, protected environment",
    ),
    ("infra/provisioning/scripts/check_private_tenant_plan.py", True, "provision-tenant.yml"),
    # Jobs with no permissions block hold the repository default (write) token.
    (
        "scripts/mail-spool-proof/ghost-send-timeout.image.test.mjs",
        True,
        "build.yml build declares no permissions: default write token",
    ),
    (
        "themes/image/themes.image.test.mjs",
        True,
        "build.yml build declares no permissions",
    ),
    (
        "themes/lib/origins.mjs",
        True,
        "imported by a test that build.yml build runs",
    ),
    (
        "services/export-bundler/test/image/export-reimport.image.test.mjs",
        True,
        "build.yml build declares no permissions",
    ),
    (
        "services/export-bundler/test/image/ghost-container.mjs",
        True,
        "imported by a test that build.yml build runs",
    ),
    (
        "adapters/stripe-connect-limit/test/image/stripe-refusal.image.test.mjs",
        True,
        "build.yml build declares no permissions",
    ),
    (
        "adapters/sso/test/image/provision-owner.image.test.mjs",
        True,
        "run by pnpm run test:image in build.yml build",
    ),
    (
        "adapters/sso/test/helpers/token.mjs",
        True,
        "imported by a test that build.yml build runs",
    ),
    (
        "adapters/scanning-storage/test/helpers/docker-ghost.mjs",
        True,
        "imported by a test that build.yml build runs",
    ),
    # Criterion 2: manifests of directories where a secret-bearing job installs,
    # builds, runs scripts from or publishes.
    ("package.json", True, "root manifest"),
    ("render-core/package.json", True, "publish-render-core.yml, packages write"),
    ("infra/tenant/package.json", True, "publish-tenant-package.yml"),
    ("infra/tenant/pnpm-workspace.yaml", True, "publish-tenant-package.yml"),
    ("services/broker/package.json", True, "broker-release.yml build feeds release"),
    ("services/broker/pnpm-workspace.yaml", True, "broker-release.yml"),
    ("services/major-watcher/package.json", True, "major-watcher-run.yml, notification token"),
    ("services/mail-collector/package.json", True, "token mounted into docker build"),
    ("services/mail-collector/pnpm-workspace.yaml", True, "same"),
    ("deadmans-switch/package.json", True, "same Dockerfile installs it"),
    ("services/mailgun-shim/package.json", True, "mailgun-shim-image.yml"),
    ("services/mailgun-shim/pnpm-workspace.yaml", True, "same"),
    ("services/drain-sidecar/package.json", True, "drain-sidecar-image.yml build feeds push"),
    ("services/demo-gate/package.json", True, "demo-gate Dockerfile mounts the token"),
    ("services/identity/package.json", True, "portal-apps-image.yml push"),
    ("portal/apps/package.json", True, "portal-apps-image.yml push"),
    ("portal/apps/pnpm-workspace.yaml", True, "same"),
    ("portal/data/package.json", True, "same"),
    ("adapters/sso/package.json", True, "generate-lockfile.yml may target it"),
    ("infra/hosts/package.json", True, "infra-hosts-ci.yml plan and apply"),
    ("infra/hosts/pnpm-workspace.yaml", True, "same"),
    ("infra/demo-host/package.json", True, "infra-demo-host-ci.yml"),
    (
        "services/sweego-webhook-receiver/pnpm-workspace.yaml",
        True,
        "install-script allow list, generate-lockfile.yml target",
    ),
    ("services/storage-gateway/.npmrc", True, "registry credentials file"),
    ("services/mail-collector/Dockerfile", True, "mounts the registry token"),
    ("portal/Dockerfile", True, "mounts the registry token"),
    # Criterion 2: keys, access, break-glass, grants.
    ("db/provision/provision_tenant_db.py", True, "db grants"),
    ("db/tunnel/tunnel_account.py", True, "tunnel account"),
    ("demo-host/provision/render_slot_sudoers.py", True, "sudoers writer"),
    ("demo-host/provision/branchleft_slot.py", True, "users writer"),
    ("adapters/sso/scripts/break-glass-mint.mjs", True, "break-glass"),
    ("adapters/sso/src/break-glass.js", True, "break-glass"),
    ("infra/provisioning/host-key-register.txt", True, "trusted host keys"),
    (
        "infra/provisioning/escrow/tenant-passphrase-escrow.pub.pem",
        True,
        "escrow key",
    ),
    ("services/broker/src/auth.ts", True, "who may call the broker"),
    ("services/storage-gateway/src/credentials/masterSecret.ts", True, "credentials"),
    ("app/provision/render_tenant_secrets.py", True, "secrets rendering"),
    ("infra/hosts/Pulumi.production.yaml", True, "encrypted stack config"),
    # Criterion 3: the workflows and what they read.
    (".github/workflows/registry-push.yml", True, "workflow"),
    (".github/image-mirror/images.json", True, "input of image-mirror.yml"),
    # Criterion 6: billed resources.
    ("infra/hosts/index.ts", True, "billed resources"),
    ("infra/demo-host/index.ts", True, "billed resources"),
    # Criterion 7: what deletes or stops the backups.
    ("db/provision/prune_backups.py", True, "deletes backups"),
    ("db/provision/dump_nightly.py", True, "performs the backup"),
    ("db/stack/conf.d/branchleft.cnf", True, "binlog retention"),
    ("control/provision/branchleft-backup-worker.timer", True, "schedules the backup"),
    ("db/recovery/restore_drained.py", True, "restore over a colour"),
    ("db/provision/promotion_gate.py", True, "promotion gate"),
    ("registers/tenant-names.json", True, "gate input of provision-tenant.yml"),
    # Criterion 8 and legal text.
    ("LICENSE", True, "legal text"),
    ("render-core/LICENSE", True, "legal text"),
    ("CLAUDE.md", True, "the rules"),
    # Released: documents.
    ("README.md", False, "document"),
    ("db/RUNBOOK-db.md", False, "document inside a kept directory"),
    ("infra/provisioning/scripts/restore_drill.md", False, "document inside a kept directory"),
    ("services/broker/RUNBOOK-broker-deploy.md", False, "document, caught only by the name rule"),
    # Released: lockfiles and pins.
    ("services/broker/pnpm-lock.yaml", False, "lockfile"),
    ("infra/hosts/pnpm-lock.yaml", False, "lockfile inside a kept directory"),
    ("demo-host/provision/tier2/ca/go.sum", False, "lockfile"),
    ("infra/hosts/.nvmrc", False, "pin inside a kept directory"),
    (".python-version", False, "pin"),
    # Released: checkers, probes and tests that no secret-bearing job runs.
    ("scripts/resolve-published-image.sh", False, "image-attestation-tokenless.yml, read-only token"),
    ("scripts/probe-tokenless-attestation.sh", False, "same job"),
    ("scripts/test-probe-tokenless-attestation.sh", False, "image-attestation-ci.yml, no token"),
    ("scripts/test_image_mirror.py", False, "image-mirror-ci.yml, no token"),
    ("scripts/test_probe_private_packages.py", False, "image-mirror-ci.yml, no token"),
    ("scripts/select-lockfile-projects.py", False, "refresh-lockfile.yml select, contents read"),
    ("scripts/assert-slug-pattern-consistency.py", False, "repo-tooling-ci.yml, read-only token"),
    ("scripts/assert-release-age-exclude.py", False, "repo-tooling-ci.yml, read-only token"),
    ("scripts/sync-tenant-name-register.py", False, "repo-tooling-ci.yml, read-only token"),
    ("scripts/mail-spool-proof/ghostprobe.py", False, "probe no job runs"),
    ("scripts/test-colour-swap.sh", False, "proof script no job runs"),
    ("infra/provisioning/scripts/probe-gateway-storage.py", False, "probe"),
    ("infra/provisioning/scripts/test_probe_gateway_storage.py", False, "test of a probe"),
    ("infra/provisioning/scripts/prove-restore-drill.sh", False, "proof"),
    ("infra/provisioning/scripts/scratch_preflight.py", False, "scratch check"),
    ("demo-host/provision/health_router.py", False, "host configuration, gated apply"),
    ("db/provision/rewrite_media_links.py", False, "reversible dry-run-first tool"),
    ("db/provision/snapshot_probe.py", False, "probe"),
    ("control/provision/install_restore_drill.py", False, "restore drill installer"),
    ("adapters/scanning-storage/src/pdq.js", False, "product code, no criterion path"),
    ("services/request-guard/src/ceiling.ts", False, "product code, caught only by a name rule"),
    ("services/storage-gateway/src/router.ts", False, "product code"),
    ("services/demo-edge/Dockerfile", False, "digest pins only, no secret mounted"),
    ("Dockerfile", False, "image content judged by the kept gate set; no token reaches the build"),
    ("docker-entrypoint.branchleft.sh", False, "image content judged by the kept gate set"),
    (
        "services/mailgun-shim/test/helpers/connectGuardPreload.mjs",
        False,
        "test helper, caught only by a name rule",
    ),
    ("widgets/scripts/fetch-pins.mjs", False, "manual tool"),
    ("infra/hetzner-host-check/package.json", False, "installed only by a read-only-token job"),
    ("csp/proof/package.json", False, "installed only by a read-only-token job"),
    (
        "services/export-bundler/ghost-adapter/package.json",
        False,
        "nested, installed by no secret-bearing job",
    ),
)


# ---------------------------------------------------------------------------
# Workflow reader (standard library only)
# ---------------------------------------------------------------------------


class WorkflowParseError(Exception):
    """A workflow this module cannot read; the proof fails closed on it."""


@dataclass(frozen=True)
class Step:
    run: str
    workdir: str
    uses: str


@dataclass
class Job:
    workflow: str
    name: str
    needs: tuple[str, ...]
    reasons: list[str]
    steps: list[Step]
    default_workdir: str

    @property
    def secret_bearing(self) -> bool:
        return bool(self.reasons)


_Line = tuple[int, str]
_KEY = re.compile(r"^(?P<key>[A-Za-z0-9_.\-]+):(?:\s+(?P<value>.*))?$")
_EXPRESSION = re.compile(r"\$\{\{(.*?)\}\}", re.S)
_SECRET_REF = re.compile(r"(?<![\w.\-])secrets(?:\.([A-Za-z0-9_]+)|\s*\[)")


def _secret_names(text: str) -> list[str]:
    """Secrets other than the read GITHUB_TOKEN that expressions in the text use."""
    names: list[str] = []
    for expression in _EXPRESSION.findall(text):
        for match in _SECRET_REF.finditer(expression):
            if match.group(1) != "GITHUB_TOKEN":
                names.append(match.group(1) or "[...]")
    return names
_BLOCK_SCALAR = re.compile(r"^[|>][+\-0-9]*$")


def _significant(text: str) -> list[_Line]:
    lines: list[_Line] = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append((len(raw) - len(raw.lstrip(" ")), stripped))
    return lines


def _block(lines: Sequence[_Line], start: int, allow_dash_at_indent: bool = False) -> int:
    """Index one past the lines nested under lines[start]."""
    indent = lines[start][0]
    end = start + 1
    while end < len(lines):
        deeper = lines[end][0] > indent
        dash = allow_dash_at_indent and lines[end][0] == indent and lines[end][1].startswith("- ")
        if not (deeper or dash):
            break
        end += 1
    return end


def _direct_keys(lines: Sequence[_Line]) -> dict[str, tuple[str, list[_Line]]]:
    """Keys at the shallowest indent of the block: name -> (inline value, nested lines)."""
    if not lines:
        return {}
    indent = min(i for i, _ in lines)
    out: dict[str, tuple[str, list[_Line]]] = {}
    position = 0
    while position < len(lines):
        line_indent, text = lines[position]
        if line_indent != indent:
            position += 1
            continue
        match = _KEY.match(text)
        if match is None:
            position += 1
            continue
        end = _block(lines, position, allow_dash_at_indent=True)
        out[match["key"]] = ((match["value"] or "").strip(), list(lines[position + 1 : end]))
        position = end
    return out


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _holds_write(value: str, nested: Sequence[_Line]) -> bool:
    text = " ".join([value, *(t for _, t in nested)])
    return re.search(r"\bwrite(?:-all)?\b", text) is not None


def _needs(value: str, nested: Sequence[_Line]) -> tuple[str, ...]:
    names: list[str] = []
    if value:
        names += [n.strip(" '\"") for n in value.strip("[]").split(",")]
    for _, text in nested:
        if text.startswith("- "):
            names.append(text[2:].strip(" '\""))
    return tuple(n for n in names if n)


def _steps(job_lines: Sequence[_Line], workflow: str, job: str) -> list[Step]:
    keys = _direct_keys(job_lines)
    if "steps" not in keys:
        return []
    value, nested = keys["steps"]
    if value:
        raise WorkflowParseError(f"{workflow}: job {job}: steps are not a block list")
    dashes = [i for i, (_, t) in enumerate(nested) if t.startswith("- ") or t == "-"]
    if not dashes:
        return []
    item_indent = min(nested[i][0] for i in dashes)
    starts = [i for i in dashes if nested[i][0] == item_indent]
    out: list[Step] = []
    for number, start in enumerate(starts):
        end = starts[number + 1] if number + 1 < len(starts) else len(nested)
        first_indent, first = nested[start]
        body = first[1:].lstrip()
        key_indent = first_indent + (len(first) - len(body))
        lines: list[_Line] = [(key_indent, body)] if body else []
        lines += nested[start + 1 : end]
        step = _direct_keys(lines)
        run_value, run_nested = step.get("run", ("", []))
        if _BLOCK_SCALAR.match(run_value):
            run = "\n".join(t for _, t in run_nested)
        else:
            run = _unquote(run_value) + ("\n" + "\n".join(t for _, t in run_nested) if run_nested else "")
        out.append(
            Step(
                run=run,
                workdir=_unquote(step.get("working-directory", ("", []))[0]),
                uses=_unquote(step.get("uses", ("", []))[0]),
            )
        )
    return out


def parse_workflow(name: str, text: str) -> list[Job]:
    """Read the jobs of one workflow. Raises WorkflowParseError when it cannot."""
    lines = _significant(text)
    if any(raw.startswith("\t") for raw in text.splitlines()):
        raise WorkflowParseError(f"{name}: tab indentation")
    top = _direct_keys(lines)
    if "jobs" not in top or not top["jobs"][1]:
        raise WorkflowParseError(f"{name}: no jobs block")
    workflow_permissions = top.get("permissions")
    workflow_secrets: list[str] = []
    for key, (value, nested) in top.items():
        if key != "jobs":
            workflow_secrets += _secret_names("\n".join([value, *(t for _, t in nested)]))
    jobs_lines = top["jobs"][1]
    job_indent = min(i for i, _ in jobs_lines)
    heads = [
        n for n, (i, t) in enumerate(jobs_lines) if i == job_indent and _KEY.match(t)
    ]
    if not heads:
        raise WorkflowParseError(f"{name}: no job found")
    jobs: list[Job] = []
    for number, head in enumerate(heads):
        end = heads[number + 1] if number + 1 < len(heads) else len(jobs_lines)
        job_name = jobs_lines[head][1].split(":", 1)[0]
        body = jobs_lines[head + 1 : end]
        keys = _direct_keys(body)
        reasons: list[str] = []
        if "permissions" in keys:
            if _holds_write(*keys["permissions"]):
                reasons.append("job permissions include write")
        elif workflow_permissions is not None:
            if _holds_write(*workflow_permissions):
                reasons.append("workflow permissions include write")
        elif REPO_DEFAULT_TOKEN_IS_WRITE:
            reasons.append("no permissions block: the repository default token is write")
        if "environment" in keys:
            reasons.append("names an environment")
        if "secrets" in keys:
            reasons.append("passes secrets to a reusable workflow")
        for secret in _secret_names("\n".join(t for _, t in body)):
            reasons.append(f"references secret {secret}")
        for secret in workflow_secrets:
            reasons.append(f"workflow-level secret {secret}")
        defaults_workdir = ""
        if "defaults" in keys:
            for _, line in keys["defaults"][1]:
                match = re.match(r"working-directory:\s*(\S+)", line)
                if match:
                    defaults_workdir = _unquote(match.group(1))
        if "steps" not in keys and "uses" not in keys:
            raise WorkflowParseError(f"{name}: job {job_name}: neither steps nor uses")
        jobs.append(
            Job(
                workflow=name,
                name=job_name,
                needs=_needs(*keys.get("needs", ("", []))),
                reasons=sorted(set(reasons)),
                steps=_steps(body, name, job_name),
                default_workdir=defaults_workdir,
            )
        )
    return jobs


def feeders(jobs: Sequence[Job]) -> set[str]:
    """Names of the jobs that are not secret-bearing but whose output one consumes."""
    by_name = {j.name: j for j in jobs}
    found: set[str] = set()

    def walk(name: str) -> None:
        for dependency in by_name[name].needs if name in by_name else ():
            if dependency in by_name and dependency not in found:
                found.add(dependency)
                walk(dependency)

    for job in jobs:
        if job.secret_bearing:
            walk(job.name)
    return {n for n in found if not by_name[n].secret_bearing}


# ---------------------------------------------------------------------------
# What a job executes
# ---------------------------------------------------------------------------

_WORKSPACE_PREFIXES = ("${GITHUB_WORKSPACE}/", "$GITHUB_WORKSPACE/", "${{ github.workspace }}/")
_TOKEN = re.compile(r"[A-Za-z0-9_./*?@+\-]+")
_PM = re.compile(r"\b(?:pnpm|npm|npx|yarn|corepack)\b")
_PM_RUN = re.compile(r"\b(?:pnpm|npm|yarn)\b([^\n;&|]*)")
_DIR_FLAG = re.compile(r"(?:--dir|-C|--prefix)[ =](\S+)")


def _is_code(path: str) -> bool:
    return path.endswith(CODE_SUFFIXES)


def _glob_regex(pattern: str) -> "re.Pattern[str]":
    out: list[str] = []
    for char in pattern:
        out.append("[^/]*" if char == "*" else "[^/]" if char == "?" else re.escape(char))
    return re.compile("".join(out))


class Tree:
    """The repository's files, with a way to read one."""

    def __init__(self, files: Iterable[str], read: Callable[[str], str]):
        self.files = sorted(set(files))
        self.members = set(self.files)
        self._read = read

    def read(self, path: str) -> str:
        return self._read(path)

    def expand(self, pattern: str) -> list[str]:
        pattern = posixpath.normpath(pattern)
        if "*" not in pattern and "?" not in pattern:
            return [pattern] if pattern in self.members else []
        regex = _glob_regex(pattern)
        return [f for f in self.files if regex.fullmatch(f)]


def live_tree() -> Tree:
    files: list[str] = []
    for root, dirs, names in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules")]
        for name in names:
            files.append(os.path.relpath(os.path.join(root, name), REPO).replace(os.sep, "/"))
    return Tree(files, lambda p: (REPO / p).read_text(encoding="utf-8", errors="replace"))


def _clean(text: str) -> str:
    for prefix in _WORKSPACE_PREFIXES:
        text = text.replace(prefix, "")
    return text


def _paths_in(text: str, bases: Sequence[str], tree: Tree) -> list[str]:
    found: list[str] = []
    for line in _clean(text).splitlines():
        if line.strip().startswith("#"):
            continue
        for token in _TOKEN.findall(line):
            if not _is_code(token.rstrip(".")):
                continue
            token = token.rstrip(".")
            for base in bases:
                found += tree.expand(posixpath.join(base, token))
    return found


_JS_IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.{1,2}/[^'"]+)['"]""")
_PY_IMPORT = re.compile(r"^\s*(?:from|import)\s+([A-Za-z_]\w*)", re.M)


def _imports(path: str, tree: Tree) -> list[str]:
    base = posixpath.dirname(path)
    text = tree.read(path)
    out: list[str] = []
    if path.endswith((".mjs", ".js", ".cjs", ".ts", ".tsx")):
        for match in _JS_IMPORT.finditer(text):
            target = posixpath.normpath(posixpath.join(base, match.group(1)))
            for candidate in (target, target + ".mjs", target + ".js", target + ".ts", target + "/index.js"):
                if candidate in tree.members:
                    out.append(candidate)
                    break
    elif path.endswith(".py"):
        for match in _PY_IMPORT.finditer(text):
            candidate = posixpath.join(base, match.group(1) + ".py")
            if candidate in tree.members:
                out.append(candidate)
    return out


def _import_closure(path: str, tree: Tree) -> list[str]:
    """Files the file imports, directly or through other imports (not the file itself)."""
    seen: set[str] = set()
    queue = [path]
    while queue:
        for dependency in _imports(queue.pop(), tree):
            if dependency not in seen and dependency != path:
                seen.add(dependency)
                queue.append(dependency)
    return sorted(seen)


def _package_scripts(package_dir: str, tree: Tree) -> dict[str, str]:
    manifest = posixpath.join(package_dir, "package.json")
    if manifest not in tree.members:
        return {}
    try:
        scripts = json.loads(tree.read(manifest)).get("scripts", {})
    except ValueError as error:
        raise WorkflowParseError(f"{manifest}: not valid JSON ({error})") from error
    return {k: v for k, v in scripts.items() if isinstance(v, str)}


def _script_files(
    package_dir: str, name: str, tree: Tree, seen: set[tuple[str, str]], depth: int = 0
) -> list[str]:
    """Files a package script (with its pre and post hooks) names, and scripts it runs."""
    if depth > 4:
        return []
    scripts = _package_scripts(package_dir, tree)
    found: list[str] = []
    for variant in (f"pre{name}", name, f"post{name}"):
        if variant not in scripts or (package_dir, variant) in seen:
            continue
        seen.add((package_dir, variant))
        text = scripts[variant]
        found += _paths_in(text, [package_dir], tree)
        for match in re.finditer(r"\b(?:pnpm|npm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_\-.]+)", text):
            found += _script_files(package_dir, match.group(1), tree, seen, depth + 1)
    return found


def _step_dirs(job: Job, step: Step, dynamic: Optional[Sequence[str]]) -> list[str]:
    """Repository directories a step runs in ("" is the root).

    A directory set at run time is replaced by the patterns the workflow is
    declared to take, and one that is not declared fails closed. A path outside
    the checkout (a runner temp directory) puts the step at the root.
    """
    workdir = step.workdir or job.default_workdir
    if "$" in workdir:
        if dynamic is None:
            raise WorkflowParseError(
                f"{job.workflow}: job {job.name}: a working directory is set at run time; "
                "name its directory patterns in DYNAMIC_PACKAGE_DIRS"
            )
        return list(dynamic) or [""]
    if workdir.startswith("/"):
        return [""]
    return [posixpath.normpath(workdir)] if workdir not in ("", ".") else [""]


def _discovered_tests(run: str, workdirs: Sequence[str], tree: Tree) -> list[str]:
    """Files `python3 -m unittest discover -s <dir> -p <pattern>` runs (top level of the directory)."""
    found: list[str] = []
    for line in _clean(run).splitlines():
        if "unittest" not in line or "discover" not in line or line.strip().startswith("#"):
            continue
        start = re.search(r"(?:^|\s)-s\s+['\"]?([^\s'\"]+)", line)
        pattern = re.search(r"(?:^|\s)-p\s+['\"]?([^\s'\"]+)", line)
        for base in workdirs:
            directory = posixpath.join(base, start.group(1) if start else ".")
            found += tree.expand(posixpath.join(directory, pattern.group(1) if pattern else "test*.py"))
    return found


def _manifests_in(directory: str, tree: Tree) -> list[str]:
    return [p for n in MANIFEST_NAMES for p in tree.expand(posixpath.join(directory, n))]


def _command_flags_dir(command: str) -> Optional[str]:
    match = _DIR_FLAG.search(command)
    return _unquote(match.group(1)) if match else None


@dataclass(frozen=True)
class Input:
    workflow: str
    job: str
    path: str
    why: str


def job_inputs(job: Job, tree: Tree, dynamic: Mapping[str, tuple[str, ...]]) -> Iterator[Input]:
    """Every repository file the job executes or installs from."""
    extra = dynamic.get(job.workflow)

    def emit(path: str, why: str) -> Input:
        return Input(job.workflow, job.name, path, why)

    for step in job.steps:
        workdirs = _step_dirs(job, step, extra)
        # A name in a run line is read against the working directory and the root.
        bases = sorted(set(workdirs) | {""})
        for path in _paths_in(step.run, bases, tree):
            yield emit(path, "named in a run step")
            for dependency in _import_closure(path, tree):
                yield emit(dependency, f"imported by {path}")
        for path in _discovered_tests(step.run, workdirs, tree):
            yield emit(path, "found by unittest discover")
            for dependency in _import_closure(path, tree):
                yield emit(dependency, f"imported by {path}")
        if _PM.search(step.run):
            for directory in workdirs:
                for path in _manifests_in(directory, tree):
                    yield emit(path, "a package manager runs in this directory")
            for match in _PM_RUN.finditer(_clean(step.run)):
                command = match.group(1)
                flagged = _command_flags_dir(command)
                command = _DIR_FLAG.sub("", command)
                dirs = (
                    [posixpath.normpath(posixpath.join(d, flagged)) for d in workdirs]
                    if flagged
                    else workdirs
                )
                words = [w for w in command.split() if not w.startswith("-")]
                names = words[1:2] if words and words[0] in ("run", "run-script") else words[:1]
                for directory in dirs:
                    if flagged:
                        for path in _manifests_in(directory, tree):
                            yield emit(path, "a package manager runs in this directory")
                    for script in names:
                        for path in _script_files(directory, script, tree, set()):
                            yield emit(path, f"run by package script {script}")
                            for dependency in _import_closure(path, tree):
                                yield emit(dependency, f"imported by {path}")
        if step.uses.startswith("pnpm/action-setup") and "package.json" in tree.members:
            yield emit("package.json", "pnpm/action-setup reads the packageManager field")
        for dockerfile, copied in _docker_secret_inputs(step, tree, workdirs):
            yield emit(dockerfile, "docker build mounts a secret")
            for path in copied:
                yield emit(path, f"copied into the image by {dockerfile}")
    for pattern in extra or ():
        if any(_PM.search(s.run) for s in job.steps):
            for name in MANIFEST_NAMES:
                for path in tree.expand(posixpath.join(pattern, name)):
                    yield emit(path, "a package manager runs in a directory chosen at run time")


_DOCKER_VALUE_FLAGS = ("-f", "--file", "-t", "--tag", "--secret", "--build-arg", "--target", "--platform", "--label")


def _docker_secret_inputs(
    step: Step, tree: Tree, bases: Sequence[str]
) -> list[tuple[str, list[str]]]:
    out: list[tuple[str, list[str]]] = []
    text = _clean(step.run).replace("\\\n", " ")
    for line in text.splitlines():
        if not re.search(r"\bdocker\s+build\b", line) or "--secret" not in line:
            continue
        words = line.split()
        position = words.index("build") + 1
        dockerfile: Optional[str] = None
        context = "."
        index = position
        positionals: list[str] = []
        while index < len(words):
            word = words[index]
            if word in ("-f", "--file") and index + 1 < len(words):
                dockerfile = words[index + 1]
                index += 2
                continue
            if word.startswith("--file="):
                dockerfile = word.split("=", 1)[1]
            elif word in _DOCKER_VALUE_FLAGS:
                index += 2
                continue
            elif not word.startswith("-"):
                positionals.append(word)
            index += 1
        if positionals:
            context = positionals[-1]
        for base in bases:
            context_dir = posixpath.normpath(posixpath.join(base, context))
            file = posixpath.normpath(
                posixpath.join(base, dockerfile) if dockerfile else posixpath.join(context_dir, "Dockerfile")
            )
            if file not in tree.members:
                continue
            copied: list[str] = []
            for copy in re.finditer(r"^\s*COPY\s+(?:--\S+\s+)*(.+)$", tree.read(file), re.M):
                sources = copy.group(1).split()[:-1]
                for source in sources:
                    if posixpath.basename(source) in MANIFEST_NAMES:
                        copied += tree.expand(posixpath.join(context_dir, source))
            out.append((file, copied))
    return out


def unowned_inputs(
    workflows: Mapping[str, str],
    tree: Tree,
    rules: Sequence[Rule],
    dynamic: Mapping[str, tuple[str, ...]] = DYNAMIC_PACKAGE_DIRS,
) -> list[Input]:
    """Inputs of secret-bearing and feeding jobs that no rule owns."""
    missing: dict[tuple[str, str, str], Input] = {}
    for name in sorted(workflows):
        jobs = parse_workflow(name, workflows[name])
        feed = feeders(jobs)
        for job in jobs:
            for item in job_inputs(job, tree, dynamic):
                holds = job.secret_bearing or job.name in feed
                docker = item.why.startswith(("docker build", "copied into the image"))
                if not (holds or docker):
                    continue
                if owning_rule(rules, item.path) is None:
                    missing[(item.workflow, item.job, item.path)] = item
    return list(missing.values())


def live_workflows() -> dict[str, str]:
    directory = REPO / ".github" / "workflows"
    return {
        p.name: p.read_text(encoding="utf-8")
        for p in sorted(directory.iterdir())
        if p.suffix in (".yml", ".yaml")
    }


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
        self.assertGreaterEqual(sum(1 for _, o, _ in SAMPLES if o), 90)
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


class ReadingTheWorkflows(unittest.TestCase):
    """The reader, on small workflows written for the purpose."""

    def jobs(self, text: str) -> dict[str, Job]:
        return {j.name: j for j in parse_workflow("w.yml", text)}

    def test_no_permissions_anywhere_holds_the_repository_default_write_token(self) -> None:
        jobs = self.jobs(
            "name: x\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: node --test a/b.test.mjs\n"
        )
        self.assertTrue(REPO_DEFAULT_TOKEN_IS_WRITE)
        self.assertTrue(jobs["build"].secret_bearing, jobs["build"].reasons)
        self.assertIn("default token is write", jobs["build"].reasons[0])

    def test_an_explicit_read_block_at_workflow_level_is_not_secret_bearing(self) -> None:
        jobs = self.jobs(
            "on: push\npermissions:\n  contents: read\njobs:\n  build:\n"
            "    runs-on: x\n    steps:\n      - run: node a.mjs\n"
        )
        self.assertFalse(jobs["build"].secret_bearing, jobs["build"].reasons)

    def test_an_empty_permissions_block_holds_no_token_rights(self) -> None:
        jobs = self.jobs(
            "on: push\njobs:\n  build:\n    permissions: {}\n    runs-on: x\n"
            "    steps:\n      - run: node a.mjs\n"
        )
        self.assertFalse(jobs["build"].secret_bearing, jobs["build"].reasons)

    def test_a_job_block_overrides_the_workflow_block_both_ways(self) -> None:
        jobs = self.jobs(
            "on: push\npermissions:\n  contents: read\njobs:\n  push:\n"
            "    permissions:\n      contents: read\n      packages: write\n"
            "    runs-on: x\n    steps:\n      - run: node a.mjs\n"
            "  check:\n    runs-on: x\n    steps:\n      - run: node b.mjs\n"
        )
        self.assertTrue(jobs["push"].secret_bearing)
        self.assertFalse(jobs["check"].secret_bearing)

    def test_an_environment_or_a_secret_other_than_the_read_token_is_secret_bearing(self) -> None:
        text = (
            "on: push\npermissions: read-all\njobs:\n"
            "  env_job:\n    environment: production\n    runs-on: x\n    steps:\n      - run: a\n"
            "  secret_job:\n    runs-on: x\n    steps:\n      - run: a\n"
            "        env:\n          K: ${{ secrets.DEPLOY_KEY }}\n"
            "  token_job:\n    runs-on: x\n    steps:\n      - run: a\n"
            "        env:\n          K: ${{ secrets.GITHUB_TOKEN }}\n"
        )
        jobs = self.jobs(text)
        self.assertTrue(jobs["env_job"].secret_bearing)
        self.assertTrue(jobs["secret_job"].secret_bearing)
        self.assertFalse(jobs["token_job"].secret_bearing)

    def test_a_job_that_a_secret_bearing_job_needs_is_a_feeder(self) -> None:
        jobs = parse_workflow(
            "w.yml",
            "on: push\npermissions: read-all\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: a\n"
            "  release:\n    needs: [build]\n    permissions:\n      id-token: write\n"
            "    runs-on: x\n    steps:\n      - run: b\n"
            "  lint:\n    runs-on: x\n    steps:\n      - run: c\n",
        )
        self.assertEqual(feeders(jobs), {"build"})

    def test_comments_do_not_count(self) -> None:
        jobs = self.jobs(
            "on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n"
            "    # permissions: write-all and secrets.NOPE\n    steps:\n      - run: b\n"
        )
        self.assertFalse(jobs["a"].secret_bearing, jobs["a"].reasons)

    def test_a_workflow_it_cannot_read_fails_closed(self) -> None:
        for text in ("name: no jobs here\n", "jobs:\n  a:\n    runs-on: x\n"):
            with self.subTest(text=text):
                with self.assertRaises(WorkflowParseError):
                    parse_workflow("w.yml", text)


def _tree(files: Mapping[str, str]) -> Tree:
    return Tree(files, lambda p: files[p])


class InputsOfAJobWithNoPermissions(unittest.TestCase):
    """A job with no permissions block must have its inputs owned, as a write-token job does."""

    FILES = {
        "tests/image/probe.image.test.mjs": "import { x } from './helper.mjs';\n",
        "tests/image/helper.mjs": "export const x = 1;\n",
        "package.json": "{}",
    }
    WORKFLOW = (
        "name: build\non: push\n{perm}jobs:\n  build:\n    runs-on: x\n    steps:\n"
        "      - run: node --test tests/image/probe.image.test.mjs\n"
    )
    OWNERS = "/package.json @branchLeft/branchleft-admin\n"

    def missing(self, permissions: str, owners: str) -> list[str]:
        workflows = {"build.yml": self.WORKFLOW.format(perm=permissions)}
        found = unowned_inputs(workflows, _tree(self.FILES), parse_codeowners(owners), {})
        return sorted(item.path for item in found)

    def test_what_a_no_permissions_job_runs_must_be_owned_with_what_it_imports(self) -> None:
        self.assertEqual(
            self.missing("", self.OWNERS),
            ["tests/image/helper.mjs", "tests/image/probe.image.test.mjs"],
        )

    def test_once_the_job_and_its_import_are_owned_nothing_is_missing(self) -> None:
        owners = self.OWNERS + "/tests/image/ @branchLeft/branchleft-admin\n"
        self.assertEqual(self.missing("", owners), [])

    def test_the_same_job_with_an_explicit_read_block_needs_none_of_it_owned(self) -> None:
        self.assertEqual(self.missing("permissions:\n  contents: read\n", self.OWNERS), [])

    def test_a_job_that_holds_a_write_permission_must_have_them_owned_too(self) -> None:
        self.assertEqual(
            self.missing("permissions:\n  packages: write\n", self.OWNERS),
            ["tests/image/helper.mjs", "tests/image/probe.image.test.mjs"],
        )


class ReadingWhatAJobRuns(unittest.TestCase):
    """Each way a job names a file to run, on a small tree, for a job that holds a write token."""

    FILES = {
        "app/package.json": json.dumps({"scripts": {"bundle": "node esbuild.bundle.mjs", "t": "node --test t/*.mjs"}}),
        "app/esbuild.bundle.mjs": "",
        "app/t/a.mjs": "import { b } from './b.mjs';\n",
        "app/t/b.mjs": "",
        "app/pnpm-workspace.yaml": "",
        "app/Dockerfile": "COPY lib/package.json ./lib/\nRUN true\n",
        "app/lib/package.json": "{}",
        "checks/test_x.py": "import helper\n",
        "checks/helper.py": "",
    }
    HEAD = "on: push\npermissions:\n  packages: write\njobs:\n  j:\n    runs-on: x\n    steps:\n"

    def inputs(self, run: str, workdir: str = "") -> set[str]:
        wd = f"        working-directory: {workdir}\n" if workdir else ""
        text = self.HEAD + f"      - name: s\n{wd}        run: {run}\n"
        found = unowned_inputs({"w.yml": text}, _tree(self.FILES), [], {})
        return {item.path for item in found}

    def test_a_package_script_is_followed_into_the_file_it_runs(self) -> None:
        self.assertIn("app/esbuild.bundle.mjs", self.inputs("pnpm run bundle", "app"))

    def test_a_glob_in_a_package_script_is_expanded_and_followed_into_its_imports(self) -> None:
        self.assertGreaterEqual(self.inputs("pnpm run t", "app"), {"app/t/a.mjs", "app/t/b.mjs"})

    def test_a_package_manager_in_a_directory_needs_its_manifests_owned(self) -> None:
        self.assertGreaterEqual(self.inputs("pnpm install", "app"), {"app/package.json", "app/pnpm-workspace.yaml"})

    def test_unittest_discover_reads_the_start_directory_and_pattern(self) -> None:
        self.assertGreaterEqual(
            self.inputs("python3 -m unittest discover -s checks -p 'test_*.py'"),
            {"checks/test_x.py", "checks/helper.py"},
        )

    def test_a_docker_build_that_mounts_a_secret_needs_the_dockerfile_and_copied_manifests(self) -> None:
        self.assertGreaterEqual(
            self.inputs("docker build --secret id=t,env=T --tag x app"),
            {"app/Dockerfile", "app/lib/package.json"},
        )

    def test_a_comment_line_in_a_run_block_names_nothing_but_a_command_line_does(self) -> None:
        self.assertEqual(self.inputs("|\n          # node app/esbuild.bundle.mjs"), set())
        self.assertEqual(self.inputs("|\n          node app/esbuild.bundle.mjs"), {"app/esbuild.bundle.mjs"})

    def test_a_working_directory_set_at_run_time_fails_closed_unless_declared(self) -> None:
        text = self.HEAD + "      - run: node a.mjs\n        working-directory: ${{ inputs.dir }}\n"
        with self.assertRaises(WorkflowParseError):
            unowned_inputs({"w.yml": text}, _tree(self.FILES), [], {})
        self.assertEqual(unowned_inputs({"w.yml": text}, _tree(self.FILES), [], {"w.yml": ()}), [])


class SecretBearingJobsOwnTheirInputs(CodeownersCase):
    def test_every_file_a_secret_bearing_or_feeding_job_runs_is_owned(self) -> None:
        tree = live_tree()
        try:
            missing = unowned_inputs(live_workflows(), tree, self.rules)
        except WorkflowParseError as error:
            self.fail(f"cannot read a workflow, so it cannot be proven: {error}")
        lines = [f"{m.workflow} job {m.job}: {m.path} ({m.why})" for m in missing]
        self.assertEqual(
            lines,
            [],
            "\nA secret-bearing job (a job with no permissions block counts: the "
            "repository default token is write) runs these files, and no CODEOWNERS "
            "line owns them. Own them, or give the job an explicit read-only "
            "permissions block.\n" + "\n".join(lines),
        )

    def test_the_workflows_read_are_the_ones_in_the_checkout(self) -> None:
        names = sorted(live_workflows())
        self.assertGreaterEqual(len(names), 40)
        self.assertIn("build.yml", names)
        build = {j.name: j for j in parse_workflow("build.yml", live_workflows()["build.yml"])}
        self.assertIn("build", build)


if __name__ == "__main__":
    unittest.main()
