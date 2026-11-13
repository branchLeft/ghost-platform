"""The demo host mail spool CI path filter must list every input the job reads.

Run: python3 -m unittest discover -s scripts -p 'test_demo_host_mail_spool_ci_paths.py'

`.github/workflows/demo-host-mail-spool-ci.yml` starts only when a diff touches
a path in its `paths:` filter. A filter that lists one source file while the job
builds all of render-core and mounts all of demo-host/provision lets a change to
any other input merge without the job ever running. This test derives the job's
real inputs from the places that decide them, and fails for any input outside
the filter, for the two events differing, and for a filter entry that matches
nothing (a renamed file leaves one behind, silently).

Where the inputs come from:
  - render-core build: the `include` list of render-core/tsconfig.build.json,
    its relative `extends`, the import closure of src/index.ts (which must stay
    inside src/), and the files the workflow's Setup Node and Setup pnpm steps
    read (node-version-file, cache-dependency-path, render-core/package.json,
    the root package.json that pnpm/action-setup reads its version from).
  - render-core/package.json and the .npmrc beside it, which `pnpm install`
    reads from its working directory.
  - the scripts the workflow runs, and every $HERE path those shell scripts
    read, directories expanded to the files under them (the proof mounts the
    whole of demo-host/provision and copies the whole of scripts/mail-spool-proof).
  - every path a .mjs input joins onto its own directory (the compose test
    reads render-core's golden file that way).
No network, no docker: it reads the tree and the workflow only.
"""

from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path
from typing import Dict, List, Optional, Set

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ".github/workflows/demo-host-mail-spool-ci.yml"
EVENTS = ("push", "pull_request")
RENDER_CORE = "render-core"


def tracked_files(root: Path) -> List[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True, text=True
    ).stdout
    return sorted(p for p in out.split("\0") if p)


def glob_to_regex(pattern: str) -> "re.Pattern[str]":
    """GitHub's filter glob: `*` stops at `/`, `**` does not, `?` is one non-`/` char."""
    out: List[str] = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
            continue
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
            continue
        if c == "*":
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("".join(out) + r"\Z")


def event_paths(workflow_text: str, event: str) -> List[str]:
    """The `paths:` list under `on: <event>:`, read without a YAML library."""
    lines = workflow_text.splitlines()
    try:
        start = lines.index("on:")
    except ValueError:
        raise AssertionError("the workflow has no top-level `on:`") from None
    in_event = False
    in_paths = False
    found: List[str] = []
    for line in lines[start + 1 :]:
        if line and not line.startswith(" "):
            break
        m = re.match(r"^  (\w+):", line)
        if m:
            in_event = m.group(1) == event
            in_paths = False
            continue
        if not in_event:
            continue
        if re.match(r"^    paths:\s*$", line):
            in_paths = True
            continue
        if re.match(r"^    \S", line):
            in_paths = False
            continue
        if in_paths:
            item = re.match(r"^      - (.+?)\s*(?:#.*)?$", line)
            if item:
                found.append(item.group(1).strip().strip("'\""))
    return found


def step_blocks(workflow_text: str) -> List[str]:
    return re.split(r"(?m)^      - name:", workflow_text)[1:]


def jsonc_load(path: Path) -> Dict[str, object]:
    text = re.sub(r"(?m)^\s*//.*$", "", path.read_text(encoding="utf-8"))
    loaded = json.loads(text)
    assert isinstance(loaded, dict)
    return loaded


def expand(pattern_or_dir: str, files: List[str]) -> List[str]:
    """A directory (or trailing-slash path) means every tracked file under it."""
    p = pattern_or_dir.rstrip("/")
    if p in files:
        return [p]
    under = [f for f in files if f.startswith(p + "/")]
    return under


def import_closure(root: Path, files: Set[str]) -> Set[str]:
    """Files reachable from render-core/src/index.ts by relative import; refuses escapes."""
    entry = f"{RENDER_CORE}/src/index.ts"
    seen: Set[str] = set()
    todo = [entry]
    spec = re.compile(r"""(?:from|import)\s+['"]([^'"]+)['"]""")
    while todo:
        cur = todo.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for target in spec.findall((root / cur).read_text(encoding="utf-8")):
            if not target.startswith("."):
                continue
            resolved = (Path(cur).parent / target).as_posix()
            resolved = str(Path(resolved)).replace(".js", ".ts") if resolved.endswith(".js") else resolved
            norm = Path(resolved).as_posix()
            assert not norm.startswith(".."), f"{cur} imports {target}, outside the repo"
            assert norm.startswith(f"{RENDER_CORE}/src/"), (
                f"{cur} imports {target}, outside render-core/src: a build input the filter "
                "would need to name separately"
            )
            assert norm in files, f"{cur} imports {target}, which is not a tracked file"
            todo.append(norm)
    return seen


def derive_inputs(root: Path, workflow_text: str) -> Dict[str, str]:
    """Every tracked file the job reads, mapped to why."""
    files = tracked_files(root)
    fileset = set(files)
    inputs: Dict[str, str] = {WORKFLOW: "the workflow itself"}

    def add(path: str, why: str) -> None:
        if path in fileset:
            inputs.setdefault(path, why)

    # render-core build: the compiled set and its config.
    build = jsonc_load(root / RENDER_CORE / "tsconfig.build.json")
    includes = build.get("include")
    assert isinstance(includes, list) and includes, "tsconfig.build.json lists no include"
    for pat in includes:
        rx = glob_to_regex(f"{RENDER_CORE}/{pat}")
        for f in files:
            if rx.match(f):
                add(f, f"compiled by `pnpm run build` (tsconfig.build.json include {pat})")
    for f in import_closure(root, fileset):
        add(f, "imported from render-core/src/index.ts")
    add(f"{RENDER_CORE}/tsconfig.build.json", "the build's tsconfig")
    extends = build.get("extends")
    if isinstance(extends, str) and extends.startswith("."):
        ext = (Path(RENDER_CORE) / extends).as_posix().replace("/./", "/")
        add(ext, "tsconfig.build.json extends it")
    add(f"{RENDER_CORE}/package.json", "build script and dependencies")
    add(f"{RENDER_CORE}/.npmrc", "pnpm install reads it from the working directory")

    # What the workflow's setup steps read.
    for key, why in (
        ("node-version-file", "Setup Node reads the Node version from it"),
        ("cache-dependency-path", "Setup Node keys the pnpm cache on it"),
    ):
        for m in re.finditer(rf"(?m)^\s+{key}:\s*(\S+)", workflow_text):
            add(m.group(1).strip("'\""), why)
    for block in step_blocks(workflow_text):
        if "pnpm/action-setup@" in block:
            m = re.search(r"(?m)^\s+package_json_file:\s*(\S+)", block)
            add(m.group(1) if m else "package.json", "pnpm/action-setup reads the pnpm version from it")

    # Scripts the workflow runs, and what they read.
    queue: List[str] = []
    for m in re.finditer(r"(?:\./|\s)(scripts/[\w./-]+)", workflow_text):
        if m.group(1) in fileset:
            add(m.group(1), "run by the workflow")
            queue.append(m.group(1))
    for script in list(queue):
        text = (root / script).read_text(encoding="utf-8")
        if script.endswith(".sh"):
            for m in re.finditer(r"\$HERE/([\w./-]+)", text):
                ref = m.group(1)
                if ref.startswith(f"{RENDER_CORE}/dist"):
                    continue  # built from render-core/src, listed above
                for f in expand(ref, files):
                    add(f, f"read by {script} ($HERE/{ref})")
        if script.endswith(".mjs"):
            for m in re.finditer(r"join\(\s*here,((?:\s*'[^']*',?)+)\s*\)", text):
                parts = re.findall(r"'([^']*)'", m.group(1))
                resolved = (Path(script).parent.joinpath(*parts)).as_posix()
                resolved = str(Path(resolved))
                for f in expand(resolved.replace("scripts/../", ""), files):
                    add(f, f"read by {script}")
    return inputs


def problems(root: Path, workflow_text: str) -> List[str]:
    found: List[str] = []
    per_event = {e: event_paths(workflow_text, e) for e in EVENTS}
    for e, pats in per_event.items():
        if not pats:
            found.append(f"{e}: no paths filter")
        for p in pats:
            if p.startswith("!"):
                found.append(f"{e}: negated pattern {p!r} is not modelled by this test")
    if set(per_event["push"]) != set(per_event["pull_request"]):
        only = set(per_event["push"]) ^ set(per_event["pull_request"])
        found.append(f"push and pull_request filters differ in: {sorted(only)}")
    files = tracked_files(root)
    inputs = derive_inputs(root, workflow_text)
    for e, pats in per_event.items():
        regexes = [glob_to_regex(p) for p in pats]
        for path, why in sorted(inputs.items()):
            if not any(rx.match(path) for rx in regexes):
                found.append(f"{e}: input {path} is outside the filter ({why})")
        for p, rx in zip(pats, regexes):
            if not any(rx.match(f) for f in files):
                found.append(f"{e}: filter entry {p!r} matches no tracked file")
    return found


class MailSpoolCiPathsTests(unittest.TestCase):
    workflow_text: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow_text = (ROOT / WORKFLOW).read_text(encoding="utf-8")

    def test_the_filter_covers_every_input(self) -> None:
        self.assertEqual([], problems(ROOT, self.workflow_text))

    def test_the_derivation_sees_the_known_inputs(self) -> None:
        # Guards the derivation itself: an empty or shrunken input set would pass the test above.
        inputs = derive_inputs(ROOT, self.workflow_text)
        for expected in (
            "render-core/src/index.ts",
            "render-core/src/spool.ts",
            "render-core/package.json",
            "render-core/pnpm-lock.yaml",
            "render-core/tsconfig.json",
            "render-core/tsconfig.build.json",
            "render-core/.nvmrc",
            "render-core/test/golden/mail-spool-compose.demo1.yml",
            "package.json",
            "scripts/test-demo-mail-spool.sh",
            "scripts/render-mail-spool-compose.mjs",
            "scripts/render-mail-spool-compose.test.mjs",
            "scripts/mail-spool-proof/tcpprobe.js",
            WORKFLOW,
        ):
            self.assertIn(expected, inputs)
        provision = [f for f in tracked_files(ROOT) if f.startswith("demo-host/provision/")]
        self.assertTrue(provision)
        for f in provision:
            self.assertIn(f, inputs)

    def _sabotage(self, drop: str) -> List[str]:
        kept = "\n".join(
            line for line in self.workflow_text.splitlines() if line.strip() != f"- {drop}"
        )
        self.assertNotEqual(kept, self.workflow_text, f"{drop} is not in the filter")
        return problems(ROOT, kept)

    def test_sabotage_dropping_a_render_core_source_pattern_goes_red(self) -> None:
        out = self._sabotage("render-core/src/**/*.ts")
        self.assertTrue(any("render-core/src/compose.ts is outside the filter" in p for p in out), out)

    def test_sabotage_dropping_the_provision_directory_goes_red(self) -> None:
        out = self._sabotage("demo-host/provision/**")
        self.assertTrue(any("demo-host/provision/branchleft_slot.py is outside" in p for p in out), out)

    def test_sabotage_dropping_a_build_config_file_goes_red(self) -> None:
        out = self._sabotage("render-core/pnpm-lock.yaml")
        self.assertTrue(any("render-core/pnpm-lock.yaml is outside" in p for p in out), out)

    def test_sabotage_a_stale_entry_goes_red(self) -> None:
        stale = self.workflow_text.replace(
            "      - render-core/src/**/*.ts\n",
            "      - render-core/src/**/*.ts\n      - demo-host/provision/renamed_away.sh\n",
        )
        self.assertNotEqual(stale, self.workflow_text)
        out = problems(ROOT, stale)
        self.assertTrue(any("renamed_away.sh" in p and "matches no tracked file" in p for p in out), out)

    def test_sabotage_one_event_missing_an_entry_goes_red(self) -> None:
        text = self.workflow_text
        marker = "  pull_request:"
        head, tail = text.split(marker, 1)
        tail = tail.replace("      - render-core/pnpm-lock.yaml\n", "", 1)
        out = problems(ROOT, head + marker + tail)
        self.assertTrue(any("differ" in p for p in out), out)

    def test_glob_semantics(self) -> None:
        def m(pat: str, path: str) -> Optional[object]:
            return glob_to_regex(pat).match(path)

        self.assertTrue(m("a/**", "a/b/c.txt"))
        self.assertTrue(m("a/**/*.ts", "a/b/c.ts"))
        self.assertTrue(m("a/**/*.ts", "a/c.ts"))
        self.assertFalse(m("a/*.ts", "a/b/c.ts"))
        self.assertFalse(m("a/**/*.ts", "a/c.md"))
        self.assertFalse(m("a/b", "a/bc"))


if __name__ == "__main__":
    unittest.main()
