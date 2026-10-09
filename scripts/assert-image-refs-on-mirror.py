#!/usr/bin/env python3
"""Fail when an image reference in the tree is not pinned on the GHCR mirror.

Usage:
    assert-image-refs-on-mirror.py [--root DIR] [--list PATH] [--mode warn|enforce]
    assert-image-refs-on-mirror.py --self-test

Warn mode prints findings and exits 0; enforce mode exits 1 on any. Exit 2 on
a usage error. The rules and the allowance are in
scripts/assert-image-refs-on-mirror.md.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import shlex
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

DEFAULT_LIST = Path(__file__).resolve().parent.parent / ".github" / "image-mirror" / "images.json"
MIRROR_PREFIX = "branchleft/mirror/"
OWN_PREFIX = "branchleft/"
LOCAL_BUILD_TAGS = {"ci", "proof"}
SKIP_DIRS = {".git", "node_modules", "dist", "bin", "forks", "graphify-out", ".standards"}
SKIP_SUFFIXES = {".md", ".sql", ".lock", ".svg", ".png", ".map"}
MAX_BYTES = 1_000_000

IMAGE_RE = re.compile(
    r"\A(?P<repo>[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+(?=/))?(?:/[A-Za-z0-9._-]+)*)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9._-]*))?"
    r"(?:@(?P<digest>sha256:[0-9a-f]{64}))?\Z"
)
CODE_TAG_RE = re.compile(r"\A(latest|v?[0-9][A-Za-z0-9._-]*)\Z")
FROM_RE = re.compile(r"\A\s*FROM\s+(?:--[a-z-]+=\S+\s+)*(?P<ref>\S+)(?:\s+AS\s+(?P<stage>\S+))?", re.I)
YAML_IMAGE_RE = re.compile(r"\A\s*(?:-\s+)?(?:image|container):\s*(?P<ref>[^\s#]+)\s*(?:#.*)?\Z")
IMAGE_VAR_RE = re.compile(r"""[A-Z][A-Z0-9_]*_IMAGE(?::-|=)["']?(?P<ref>[^\s"'}$]+)""")
STRING_RE = re.compile(r"""(?P<q>['"`])(?P<ref>[^'"`\s]+)(?P=q)""")
DOCKER_RE = re.compile(r"\bdocker\s+(?P<verb>run|create|pull)\b(?P<rest>.*)")
VALUE_FLAGS = {
    "-v", "-e", "-p", "-w", "-u", "-h", "-l", "-m", "--name", "--network", "--net", "--ip", "--platform",
    "--log-driver", "--log-opt", "--entrypoint", "--label", "--env-file", "--user", "--cgroupns", "--add-host",
    "--tmpfs", "--mount", "--hostname", "--memory", "--cpus", "--restart", "--cap-add", "--cap-drop",
    "--security-opt", "--pid", "--workdir", "--volumes-from", "--env", "--publish", "--volume", "--dns",
    "--sysctl", "--device", "--shm-size", "--stop-timeout", "--health-cmd", "--health-interval", "--pull",
    "--network-alias", "--ulimit", "--group-add", "--uts", "--ipc", "--userns", "--gpus", "--cidfile",
    "--pids-limit", "--memory-swap", "--runtime", "--log-opt", "--dns-search", "--expose",
}
BUILD_TAG_RE = re.compile(r"docker\s+(?:buildx\s+)?build\b.*?(?:-t|--tag)[ =]\"?(?P<name>[a-z0-9][a-z0-9._/-]*)")
IP_RE = re.compile(r"\A[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+")


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    ref: str
    kind: str
    why: str

    def render(self) -> str:
        return f"{self.path}:{self.line}: [{self.kind}] {self.ref} -- {self.why}"


def classify(ref: str, mirror: set[tuple[str, str]], local: frozenset[str] = frozenset()) -> tuple[str, str] | None:
    """Return (kind, why) when the ref is not allowed, None when it is."""
    m = IMAGE_RE.match(ref)
    if not m or IP_RE.match(ref) or not re.search("[A-Za-z]", m["repo"]):
        return None  # not an image reference at all (a uid:gid, a port mapping)
    repo, tag, digest = m["repo"], m["tag"], m["digest"]
    if repo in local and not digest:
        return None  # built from this repo's own Dockerfile by `docker build -t`
    parts = repo.split("/")
    has_registry = len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost")
    if not has_registry:
        if not digest and tag in LOCAL_BUILD_TAGS and "/" not in repo:
            return None
        if "/" not in repo:
            return ("unqualified", "no registry: resolves to docker.io/library; use the mirror by digest")
        return ("docker.io", "no registry: resolves to docker.io; use the mirror by digest")
    registry, path = parts[0], "/".join(parts[1:])
    if registry in ("docker.io", "registry-1.docker.io", "index.docker.io"):
        return ("docker.io", "Docker Hub reference; use the mirror by digest")
    if registry != "ghcr.io":
        return ("other-registry", f"{registry} reference; mirror it and use the mirror by digest")
    if not path.startswith(OWN_PREFIX):
        return ("other-registry", "ghcr.io reference outside branchleft; mirror it and use the mirror by digest")
    if not digest:
        return ("tag-only", "no @sha256 digest: a tag can move; pin by digest")
    if path.startswith(MIRROR_PREFIX):
        name = path[len(MIRROR_PREFIX):]
        if (name, digest) not in mirror:
            return ("not-on-list", f"{name} {digest[:19]}... is not in the mirror list")
    return None


def tokens_after_docker(rest: str) -> str | None:
    """The first positional argument of a docker run/create/pull line, i.e. the image."""
    try:
        words = shlex.split(rest.replace("\\", " "), comments=True)
    except ValueError:
        words = rest.split()
    skip = False
    for word in words:
        if skip:
            skip = False
            continue
        if word in VALUE_FLAGS:
            skip = True
            continue
        if word.startswith("-"):
            continue
        return word
    return None


def candidates(path: str, lines: list[str]) -> list[tuple[int, str]]:
    """(line number, reference) pairs this file asks Docker to pull."""
    name = Path(path).name
    suffix = Path(path).suffix
    found: list[tuple[int, str]] = []
    stages: set[str] = set()
    is_docker = name.startswith("Dockerfile") or name.endswith(".Dockerfile")
    is_yaml = suffix in (".yml", ".yaml")
    is_code = suffix in (".ts", ".js", ".mjs", ".py", ".json")
    for i, line in enumerate(lines, 1):
        if is_docker:
            m = FROM_RE.match(line)
            if m:
                ref = m["ref"]
                if ref != "scratch" and ref not in stages and "$" not in ref:
                    found.append((i, ref))
                if m["stage"]:
                    stages.add(m["stage"])
            continue
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if is_yaml:
            m = YAML_IMAGE_RE.match(line)
            if m and "$" not in m["ref"] and m["ref"] not in ("true", "false"):
                found.append((i, m["ref"].strip("'\"")))
        if suffix in (".sh", ".yml", ".yaml"):
            for m in IMAGE_VAR_RE.finditer(line):
                if re.search(r"[:@/]", m["ref"]):
                    found.append((i, m["ref"]))
            m = DOCKER_RE.search(line)
            if m:
                joined = m["rest"]
                j = i
                while joined.rstrip().endswith("\\") and j < len(lines):
                    joined += " " + lines[j]
                    j += 1
                ref = tokens_after_docker(joined)
                if ref and "$" not in ref and not ref.startswith(("/", ".", "~")):
                    found.append((i, ref.strip("'\"")))
        elif is_code:
            window = " ".join(lines[max(0, i - 13):i]).lower()
            if "docker" not in window and "image" not in window:
                continue
            for m in STRING_RE.finditer(line):
                im = IMAGE_RE.match(m["ref"])
                if not im or "$" in m["ref"]:
                    continue
                if im["digest"] or (im["tag"] and CODE_TAG_RE.match(im["tag"])):
                    found.append((i, m["ref"]))
    return found


def tracked_files(root: Path) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z"], capture_output=True, check=True
        ).stdout.decode()
        return [p for p in out.split("\0") if p]
    except (OSError, subprocess.CalledProcessError):
        return [str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()]


def read_text(root: Path, rel: str) -> list[str] | None:
    full = root / rel
    try:
        if not full.is_file() or full.stat().st_size > MAX_BYTES:
            return None
        return full.read_text().splitlines()
    except (OSError, UnicodeDecodeError):
        return None


def local_builds(root: Path, files: list[str]) -> frozenset[str]:
    names: set[str] = set()
    for rel in files:
        if Path(rel).suffix in (".sh", ".yml", ".yaml"):
            for line in read_text(root, rel) or []:
                for m in BUILD_TAG_RE.finditer(line):
                    names.add(m["name"].split(":")[0])
    return frozenset(names)


def scan(root: Path, mirror: set[tuple[str, str]], allow: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    files = tracked_files(root)
    local = local_builds(root, files)
    for rel in sorted(files):
        p = Path(rel)
        if SKIP_DIRS & set(p.parts) or p.suffix in SKIP_SUFFIXES or p.name.startswith("package-lock"):
            continue
        if rel.startswith(".github/image-mirror/"):
            continue  # the list itself holds digests, not pulls
        if any(fnmatch.fnmatch(rel, pattern) for pattern in allow):
            continue
        lines = read_text(root, rel)
        if lines is None:
            continue
        seen: set[tuple[int, str]] = set()
        for lineno, ref in candidates(rel, lines):
            if (lineno, ref) in seen:
                continue
            seen.add((lineno, ref))
            verdict = classify(ref, mirror, local)
            if verdict:
                findings.append(Finding(rel, lineno, ref, *verdict))
    return findings


def load_policy(path: Path) -> tuple[set[tuple[str, str]], list[str]]:
    data = json.loads(path.read_text())
    mirror = {(e["name"], e["digest"]) for e in data["images"]}
    allow = []
    for entry in data.get("allow", []):
        if not entry.get("reason"):
            raise ValueError(f"allow entry {entry.get('path')!r} has no reason")
        allow.append(entry["path"])
    return mirror, allow


def run(root: Path, policy: Path, mode: str) -> int:
    mirror, allow = load_policy(policy)
    findings = scan(root, mirror, allow)
    for finding in findings:
        print(finding.render())
    print(f"image-refs: {len(findings)} reference(s) not on the mirror (mode {mode})")
    return 1 if findings and mode == "enforce" else 0


DIGEST_A = "sha256:" + "a" * 64
SELF_LIST = {"registry": "ghcr.io/branchleft/mirror", "images": [{"name": "ghost", "digest": DIGEST_A}]}


def self_test() -> int:
    """Three sabotages must go red in enforce mode, then a clean tree green."""
    cases = {
        "FROM ghost": ("Dockerfile", "FROM ghost:6.55.0-alpine\n", "unqualified"),
        "tag-only mirror ref": (
            "Dockerfile",
            "FROM ghcr.io/branchleft/mirror/ghost:6.55.0-alpine\n",
            "tag-only",
        ),
        "unqualified workflow service image": (
            ".github/workflows/ci.yml",
            "jobs:\n  t:\n    services:\n      db:\n        image: postgres:17-alpine\n",
            "unqualified",
        ),
    }
    clean = {
        "Dockerfile": f"FROM ghcr.io/branchleft/mirror/ghost@{DIGEST_A}\nFROM scratch\n",
        ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: docker build -t app:ci .\n",
    }
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        policy = Path(tmp) / "list.json"
        policy.write_text(json.dumps(SELF_LIST))
        for label, (rel, text, kind) in cases.items():
            root = Path(tmp) / label.replace(" ", "-")
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text)
            mirror, allow = load_policy(policy)
            kinds = [f.kind for f in scan(root, mirror, allow)]
            red = kinds == [kind]
            print(f"{'ok  ' if red else 'FAIL'} sabotage red: {label} -> {kinds}")
            failures += 0 if red else 1
        root = Path(tmp) / "clean"
        for rel, text in clean.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text)
        mirror, allow = load_policy(policy)
        left = scan(root, mirror, allow)
        print(f"{'ok  ' if not left else 'FAIL'} clean tree green -> {[f.render() for f in left]}")
        failures += 1 if left else 0
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--list", type=Path, default=DEFAULT_LIST)
    parser.add_argument("--mode", choices=("warn", "enforce"), default="warn")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    try:
        return run(args.root, args.list, args.mode)
    except (OSError, ValueError, KeyError) as err:
        print(f"cannot read policy {args.list}: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
