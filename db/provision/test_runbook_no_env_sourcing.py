#!/usr/bin/env python3
"""No RUNBOOK-*.md may instruct sourcing an `.env` file with bash.

`db.env` (and every sibling `*.env` file this estate hand-writes) is meant to
be *read*, never *evaluated*. A syntax error partway through -- an unquoted
`(` in a DSN was the real incident -- makes bash echo the offending line back
to the terminal, credential included, and sourcing then carries on with the
remaining variables set: the failure is silent except for the one part that
matters.

The fix is a command *shape*, not a one-off edit: `sed -n 's/^VAR=//p'` for a
single value, or `systemd-run --property=EnvironmentFile=` when a script
needs the whole environment -- both parse `KEY=value` pairs without ever
handing the file to a shell. This test asserts the shape stays out of every
runbook in this repo, the same technique
`shared-infra/hetzner/provision/test_runbook_rsync_commands.py` uses for its
own command-shape guard.
"""

import pathlib
import re
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

# Directories that hold no runbook of this repo's own and must never be
# walked into: `.git` for size; `node_modules` because a dependency could
# ship its own file named RUNBOOK-*.md; `worktrees`/`.worktrees` because this
# workspace's own convention nests other branches' checkouts there, each a
# full (possibly unfixed, possibly ahead) copy of every file in this repo --
# scanning them would fail or pass on an unrelated branch's content instead
# of this one's.
EXCLUDED_DIR_PARTS = {".git", "node_modules", "worktrees", ".worktrees"}

# A bash dot-command or `source` builtin, evaluating a path that ends in
# `.env`. Anchored so the token is a standalone command (line start, or after
# `&&`/`;`/`|`/a quote opening a remote shell string) rather than a substring
# of a filename or a sentence -- e.g. `install -m 600 ... db.env` and prose
# like "Never source this file" must not match. Matched against the whole
# document rather than fence-extracted blocks: a naive per-fence scan
# mis-pairs an opening ```bash with a later closing ``` whenever an
# intervening fence uses a different (or no) language tag, silently
# swallowing the very block it was meant to check.
ENV_SOURCE = re.compile(r"(?:^|[\s&;|'\"])(?:\.|source)\s+\S*\.env\b")


def runbooks() -> list[pathlib.Path]:
    return sorted(
        p
        for p in REPO_ROOT.rglob("RUNBOOK-*.md")
        if not EXCLUDED_DIR_PARTS & set(p.relative_to(REPO_ROOT).parts)
    )


class RunbookEnvSourcingTests(unittest.TestCase):
    def test_the_runbooks_were_actually_found(self):
        """A glob that matched nothing would pass every assertion below."""
        found = runbooks()
        self.assertGreaterEqual(
            len(found), 3, f"expected at least 3 RUNBOOK-*.md files, found {found}"
        )

    def test_no_runbook_sources_an_env_file_with_bash(self):
        for runbook in runbooks():
            text = runbook.read_text(encoding="utf-8")
            with self.subTest(runbook=runbook.relative_to(REPO_ROOT)):
                match = ENV_SOURCE.search(text)
                self.assertIsNone(
                    match,
                    f"{runbook.relative_to(REPO_ROOT)}: bash-sources an .env file "
                    f"({match.group(0) if match else ''!r}). A parse error makes bash "
                    f"echo the offending line, credential included -- read a single "
                    f"value with sed -n 's/^VAR=//p', or hand the whole file to a "
                    f"command with systemd-run --property=EnvironmentFile=.",
                )

    def test_the_matcher_actually_catches_the_incident_shape(self):
        """A regex that cannot see the real defect would pass the file it exists
        to check. Both the original `. /etc/branchleft/db.env` form and the
        `source` spelling must be caught; a value merely mentioning the path
        (e.g. `install -m 600 /dev/null /etc/branchleft/db.env`) must not."""
        positive_cases = [
            "set -a && . /etc/branchleft/db.env && set +a && python3 prune.py",
            "cd /opt && source /etc/branchleft/db.env",
        ]
        for case in positive_cases:
            with self.subTest(case=case):
                self.assertIsNotNone(ENV_SOURCE.search(case))

        negative_cases = [
            "install -m 600 /dev/null /etc/branchleft/db.env",
            "EnvironmentFile=/etc/branchleft/db.env",
            "--property=EnvironmentFile=/etc/branchleft/db.env",
            "Never source this file with `bash` to read a value out of it.",
            "rm -f /etc/branchleft/<slug>.env /etc/branchleft/<slug>.image.env",
        ]
        for case in negative_cases:
            with self.subTest(case=case):
                self.assertIsNone(ENV_SOURCE.search(case))


if __name__ == "__main__":
    unittest.main()
