#!/usr/bin/env python3
"""Fail when an image reference in the tree is not pinned on the GHCR mirror.

Usage:
    assert-image-refs-on-mirror.py [--root DIR] [--list PATH] [--mode warn|enforce]
    assert-image-refs-on-mirror.py --self-test

Warn mode prints findings and exits 0; enforce mode exits 1 on any, an UNRESOLVED
reference included. Exit 2 on a usage error. Rules: assert-image-refs-on-mirror.md.
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
MIRROR_REGISTRY = "ghcr.io/branchleft/mirror"
MIRROR_PREFIX = "branchleft/mirror/"
OWN_PREFIX = "branchleft/"
SKIP_DIRS = {".git", "node_modules", "dist", "forks", "graphify-out", ".standards"}
SKIP_SUFFIXES = {
    ".md", ".sql", ".lock", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf",
    ".map", ".gz", ".tgz", ".zip", ".pdf",
}
CODE_SUFFIXES = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json"}
YAML_SUFFIXES = {".yml", ".yaml"}
MAX_BYTES = 1_000_000
UNRESOLVED = "unresolved"

IMAGE_RE = re.compile(
    r"\A(?P<repo>[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+(?=/))?(?:/[A-Za-z0-9._-]+)*)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9._-]*))?"
    r"(?:@(?P<digest>sha256:[0-9a-f]{64}))?\Z"
)
CODE_TAG_RE = re.compile(
    r"\A(?:latest|stable|edge|lts[A-Za-z0-9._-]*|alpine[A-Za-z0-9._-]*|slim[A-Za-z0-9._-]*"
    r"|bookworm[A-Za-z0-9._-]*|trixie[A-Za-z0-9._-]*|bullseye[A-Za-z0-9._-]*|jammy|noble|v?[0-9][A-Za-z0-9._-]*"
    r"|[A-Za-z0-9._-]*-(?:alpine|slim|dind|bookworm|trixie|bullseye)[A-Za-z0-9._-]*)\Z"
)
PORT_TAG = re.compile(r"\A[0-9]{4,5}\Z")
WELL_KNOWN_NAMES = {
    "alpine", "busybox", "debian", "ubuntu", "node", "python", "postgres", "mysql", "mariadb", "redis", "nginx",
    "httpd", "caddy", "traefik", "mongo", "memcached", "rabbitmq", "golang", "ruby", "php", "openjdk", "ghost",
    "minio", "curl", "docker",
}
FILE_EXTENSIONS = {"js", "ts", "mjs", "cjs", "json", "md", "yml", "yaml", "sh", "py", "html", "css", "txt", "sql"}

FROM_RE = re.compile(r"\A\s*FROM\s+(?:--\S+\s+)*(?P<ref>\S+)(?:\s+AS\s+(?P<stage>\S+))?", re.I)
INSTRUCTION_RE = re.compile(r"\A\s*(?:ONBUILD\s+)?(?P<ins>[A-Za-z]+)\s+(?P<args>.*)\Z", re.I)
STAGE_NAME_RE = re.compile(r"\A[A-Za-z0-9_.-]+\Z")
EXPR_RE = re.compile(r"\$\{\{.*?\}\}")
VAR_RE = re.compile(
    r"\$\{(?P<name>[A-Za-z_][A-Za-z0-9_]*)(?::?(?P<op>[-=+?])(?P<arg>[^{}]*))?\}|\$(?P<bare>[A-Za-z_][A-Za-z0-9_]*)"
)
KEEP_VARS = {"IMAGE_REGISTRY"}
BLOCK_INDICATORS = {"|", ">", "|-", ">-", "|+", ">+"}
REGISTRY_VAR_START = re.compile(r"\A\$\{?IMAGE_REGISTRY")
VAR_REF = re.compile(
    r"\A\$\{IMAGE_REGISTRY:-(?P<ns>[A-Za-z0-9][A-Za-z0-9._/-]*)\}/(?P<name>[a-z0-9][a-z0-9-]*)"
    r"(?::(?P<tag>[A-Za-z0-9_][A-Za-z0-9._-]*))?(?:@(?P<digest>sha256:[0-9a-f]{64}))?\Z"
)
# A key that names an image: the YAML/TOML/JSON keys, and the env-style names
# shells, Dockerfiles and compose files use for one (IMAGE, DB_IMAGE, BLUE_TAG).
KEY_RE = re.compile(
    r"""(?<![\w.$/-])["']?(?P<key>image|container|IMAGE|[A-Z][A-Z0-9_]*_IMAGE|[A-Z][A-Z0-9_]*_TAG)["']?"""
    r"""\s*(?P<sep>[:=])(?![=:])(?=(?P<rest>.*)$)"""
)
KEY_NAME_RE = re.compile(r"\A(?:image|container|IMAGE|[A-Z][A-Z0-9_]*_IMAGE|[A-Z][A-Z0-9_]*_TAG)\Z")
DEFAULT_REF_RE = re.compile(r"\$\{(?P<var>IMAGE|[A-Z][A-Z0-9_]*_IMAGE|[A-Z][A-Z0-9_]*_TAG):?-(?P<ref>[^{}]*)\}")
CODE_STRING_RE = re.compile(r"""(?P<q>['"`])(?P<ref>[^'"`\s]+)(?P=q)""")
FLAG_VAR_RE = re.compile(r"(?i)\A\$\{?[A-Za-z_]*(?:args|opts|options|flags)\}?\Z")
SEPARATOR_RE = re.compile(r"\A[();<>|&]+\Z")
VALUE_RE = re.compile(r"(?:\$\{\{.*?\}\}|\$\{[^}]*\}|[^\s,}\]#;])+")
PROPERTY_RE = re.compile(r"(?:&[\w-]+|!\S*)\s+")
SHELL_ASSIGN_RE = re.compile(
    r"\A\s*(?:export\s+|readonly\s+|local\s+|declare\s+(?:-\w+\s+)?)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)=(?P<rest>.*)\Z"
)
YAML_ASSIGN_RE = re.compile(r"\A\s*(?:-\s+)?(?P<name>[A-Za-z_][A-Za-z0-9_-]*)\s*:\s+(?P<rest>.*)\Z")
ANCHOR_RE = re.compile(r"&(?P<anchor>[\w-]+)\s+(?P<value>[^\s,}\]#]+)")
DOCKER_URI_RE = re.compile(r"\buses:\s*[\"']?docker://(?P<ref>[^\s\"'#]+)")
BUILD_ARG_RE = re.compile(r"""--build-arg(?:\s+|=)["']?(?P<name>[A-Za-z_]\w*)=(?P<value>[^\s"']+)""")
BUILD_TAG_RE = re.compile(
    r"""(?:docker|podman)\s+(?:buildx\s+)?build\b.*?(?:-t|--tag)(?:\s+|=)["']?(?P<name>[^\s"']+)"""
    r"""|['"]build['"].*?['"](?:-t|--tag)['"]\s*,\s*['"]?(?P<arg>[A-Za-z_][\w:./-]*)"""
)
OVERRIDE_RE = re.compile(
    r"""(?<![\w$])IMAGE_REGISTRY\s*(?:=|:(?![-=+?]))\s*["']?(?P<value>\$\{\{.*?\}\}|[^\s"'#]+)"""
)
RUNTIME_RE = re.compile(
    r"(?<![\w.$-])(?:/[\w./-]*/)?(?:docker|podman|nerdctl)(?=\s)"
    r"|(?<![\w./-])(?:\$\{?|\$\()(?:DOCKER|PODMAN|DOCKER_BIN|DOCKER_CMD|CONTAINER_RUNTIME|CONTAINER_CLI)[})]?(?=\s)"
)
DOCKER_IMAGE_URI_RE = re.compile(r"""docker-image://(?P<ref>[^\s"',]+)""")
CACHE_FROM_RE = re.compile(
    r"""type=registry,(?:[^\s"']*,)?ref=(?P<ref>[^\s"',]+)|--cache-from(?:\s+|=)["']?(?P<plain>[^\s"',=]+)(?=["'\s]|\Z)"""
)
SYNTAX_DIRECTIVE_RE = re.compile(r"\A\s*#\s*(?P<key>[A-Za-z]+)\s*=\s*(?P<value>\S+)\s*\Z")
ARG_WORD_RE = re.compile(r"\A(?:-\S+|[0-9]+[smhd]?|[A-Za-z_][A-Za-z0-9_]*=\S*)\Z")
GLOBAL_VALUE_FLAGS = {"-H", "--host", "--context", "-c", "--config", "-l", "--log-level"}
VERBS = {"run", "create", "pull"}
# Flags of docker run/create/pull that take a separate value, so the value is
# not mistaken for the image.
VALUE_FLAGS = {
    "-a", "--attach", "--add-host", "--annotation", "--blkio-weight", "--cap-add", "--cap-drop", "--cgroup-parent",
    "--cgroupns", "--cidfile", "--cpu-period", "--cpu-quota", "--cpu-rt-period", "--cpu-rt-runtime", "-c",
    "--cpu-shares", "--cpus", "--cpuset-cpus", "--cpuset-mems", "--detach-keys", "--device", "--dns",
    "--dns-option", "--dns-search", "--domainname", "--entrypoint", "-e", "--env", "--env-file", "--expose",
    "--gpus", "--group-add", "--health-cmd", "--health-interval", "--health-retries", "--health-start-period",
    "--health-timeout", "-h", "--hostname", "--ip", "--ip6", "--ipc", "--isolation", "-l", "--label",
    "--label-file", "--link", "--link-local-ip", "--log-driver", "--log-opt", "--mac-address", "-m", "--memory",
    "--memory-reservation", "--memory-swap", "--memory-swappiness", "--mount", "--name", "--net", "--network",
    "--network-alias", "--oom-score-adj", "--pid", "--pids-limit", "--platform", "-p", "--publish", "--pull",
    "--restart", "--runtime", "--security-opt", "--shm-size", "--stop-signal", "--stop-timeout", "--storage-opt",
    "--sysctl", "--tmpfs", "-u", "--user", "--userns", "--uts", "-v", "--volume", "--volume-driver",
    "--volumes-from", "-w", "--workdir",
}
COMMAND_WORDS = {
    "then", "do", "else", "elif", "if", "until", "while", "sudo", "exec", "time", "eval", "command", "nohup", "xargs",
    "env", "timeout", "retry", "nice", "ionice", "watch", "!", "-",
}
YAML_COMMAND_KEY = re.compile(r"\b(?:run|command|cmd|entrypoint|script):\s*(?:[|>][-+]?)?\Z")
SHELL_STRING_PREFIX = re.compile(r"""(?:\s-c|\beval|\bssh\s+\S+|\bsh|\bbash)\s+["']\Z""")
PROSE_CALL = re.compile(r"(?:console\.|\bprint|\blog|\becho|\bwarn|\berror|\bmessage)", re.I)


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    ref: str
    kind: str
    why: str

    def render(self) -> str:
        return f"{self.path}:{self.line}: [{self.kind}] {self.ref} -- {self.why}"


@dataclass(frozen=True)
class Cand:
    line: int
    ref: str
    unresolved: bool = False


def classify(ref: str, mirror: set[tuple[str, str]], local: frozenset[str] = frozenset()) -> tuple[str, str] | None:
    """Return (kind, why) when the ref is not allowed, None when it is.

    `mirror` holds (public source path, digest) pairs from the list. `local`
    holds the `name:tag` pairs this tree builds itself with `docker build -t`.
    """
    if REGISTRY_VAR_START.match(ref):
        v = VAR_REF.match(ref)
        if not v:
            return ("bad-default", "IMAGE_REGISTRY reference is not ${IMAGE_REGISTRY:-<public namespace>}/<name>:<tag>@sha256:<digest>")
        if not v["digest"]:
            return ("tag-only", "no @sha256 digest: a tag can move; pin by digest")
        if (f"{v['ns']}/{v['name']}", v["digest"]) not in mirror:
            return ("bad-default", f"default {v['ns']}/{v['name']} is not the public source of this digest on the list")
        if not v["tag"]:
            return ("no-tag", "digest with no tag: write <name>:<tag>@sha256:<digest>")
        return None
    m = IMAGE_RE.match(ref)
    if not m or not re.search("[A-Za-z]", m["repo"]):
        return None  # not an image reference at all (a uid:gid, a port mapping, a version)
    repo, tag, digest = m["repo"], m["tag"], m["digest"]
    if not digest and f"{repo}:{tag or 'latest'}" in local:
        return None  # built from this repo's own Dockerfile by `docker build -t`
    parts = repo.split("/")
    has_registry = len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost")
    if not has_registry:
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
    if path.startswith(MIRROR_PREFIX):
        return (
            "hard-coded-mirror",
            "mirror path with no public default breaks local builds: use ${IMAGE_REGISTRY:-<public namespace>}/<name>:<tag>@sha256:<digest>",
        )
    if not digest:
        return ("tag-only", "no @sha256 digest: a tag can move; pin by digest")
    if not tag:
        return ("no-tag", "digest with no tag: write <name>:<tag>@sha256:<digest>")
    return None


# ---------------------------------------------------------------------------
# Variables: what a reference can expand to, using values defined in the repo.

Env = dict[str, list[tuple[str, bool]]]  # name -> [(value, definition flagged at its own line)]


def expand(
    ref: str,
    env: Env,
    glob: Env,
    seen: frozenset[str] = frozenset(),
    depth: int = 0,
    inherited: bool = False,
) -> tuple[list[str], bool, int] | None:
    """Every value `ref` can take, whether every substitution came from a
    definition that is itself reported, and how many substitutions were made.
    None when a value is not in the repo. `seen` holds the variables being
    expanded, so a self-reference such as ${X:-default} falls to its default;
    `inherited` says whether the definition that default came from is reported."""
    if EXPR_RE.search(ref) or "$(" in ref or "`" in ref or depth > 6:
        return None
    match = next((m for m in VAR_RE.finditer(ref) if (m["name"] or m["bare"]) not in KEEP_VARS), None)
    if match is None:
        leftover = VAR_RE.sub(lambda m: "" if (m["name"] or m["bare"]) in KEEP_VARS else "$", ref)
        return ([ref], True, 0) if "$" not in leftover else None
    name = match["name"] or match["bare"]
    op, arg = match["op"], match["arg"]
    options: list[tuple[str, bool]] = []
    if name not in seen:
        options = list(env.get(name) or glob.get(name) or [])
    if not options:
        if match["name"] and op in ("-", "="):
            options = [(arg or "", inherited and name in seen)]
        else:
            return None
    values: list[str] = []
    covered = True
    count = 1
    for value, flagged in options:
        out = expand(ref[: match.start()] + value + ref[match.end():], env, glob, seen | {name}, depth + 1, flagged)
        if out is None:
            if flagged:
                count += 1  # a reported definition whose value is not in the repo is reported there
                continue
            return None
        values += out[0]
        covered = covered and flagged and out[1]
        count += out[2]
    return (values[:16], covered, count)


# ---------------------------------------------------------------------------
# Reading a file into logical lines.

def strip_hash_comment(line: str) -> str:
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1].isspace()):
            return line[:i]
    return line


def logical_lines(lines: list[str], mode: str) -> list[tuple[int, str]]:
    """(first physical line number, text), comments dropped, backslash continuations joined.

    `mode` is "code" (// and # comment lines), "json" (no comments) or
    "shell" (a # that starts a word begins a comment).
    """
    out: list[tuple[int, str]] = []
    buf: str | None = None
    start = 0
    for number, raw in enumerate(lines, 1):
        text = raw.rstrip()
        stripped = text.strip()
        if mode == "code" and stripped.startswith(("//", "*", "/*", "#")):
            continue
        if mode == "shell":
            if stripped.startswith("#"):
                continue
            text = strip_hash_comment(text).rstrip()
        if buf is None:
            if not text.strip():
                continue
            buf, start = "", number
        elif not text.strip():
            continue
        if mode == "shell" and text.endswith("\\"):
            buf += text[:-1] + " "
            continue
        out.append((start, buf + text))
        buf = None
    if buf:
        out.append((start, buf))
    return out


def take_value(rest: str) -> tuple[str, bool]:
    """The first YAML/shell scalar in `rest`, and whether it was quoted."""
    s = rest.lstrip()
    while True:
        m = PROPERTY_RE.match(s)
        if not m:
            break
        s = s[m.end():]
    if s[:1] in ("'", '"'):
        end = s.find(s[0], 1)
        return (s[1:end] if end > 0 else s[1:]), True
    m = VALUE_RE.match(s)
    return (m.group(0) if m else ""), False


def looks_like_image(value: str) -> bool:
    m = IMAGE_RE.match(value)
    return bool(m and re.search("[A-Za-z]", m["repo"]))


def has_name(value: str) -> bool:
    return bool(re.search(r"[:@/]", value))


@dataclass(frozen=True)
class Def:
    line: int
    key: str
    value: str


@dataclass
class FileInfo:
    kind: str
    raw: list[str]
    logical: list[tuple[int, str]]
    env: Env
    defs: list[Def]  # definitions reported at their own line
    anchors: set[str]


def key_definitions(text: str, kind: str):
    """(key, value) for each image-naming key assignment on a logical line."""
    for m in KEY_RE.finditer(text):
        if m["key"] == "container" and kind != "yaml":
            continue  # a container name in a script, a label in code
        if m["sep"] == ":" and m["rest"][:1] not in ("", " ", "\t"):
            continue  # a:b with no space is not a YAML mapping
        value, quoted = take_value(m["rest"])
        if kind == "code" and not quoted:
            continue
        yield m["key"], value


def definition_ok(key: str, value: str, known: frozenset[str], text: str) -> bool:
    """True when `key: value` is a reference the guard reports at its own line."""
    value = value.removeprefix("docker://")
    if not value or value in ("true", "false", "null", "~"):
        return False
    if key.endswith("_TAG") and not has_name(value):
        return False  # a bare tag with no name is not an image reference
    if "$" in value or re.fullmatch(r"\*[\w-]+", value):
        return True  # a variable or a YAML alias: followed, or reported UNRESOLVED
    m = IMAGE_RE.match(value)
    if not m or not re.search("[A-Za-z]", m["repo"]):
        return False
    if not has_name(value) and m["repo"] not in known:
        return False  # a bare word: a Hetzner image name, a container label, a local build
    if not m["tag"] and not m["digest"] and re.search(rf"\$\{{?{re.escape(key)}\}}?[@:]", text):
        return False  # a repository name the file completes with @digest or :tag
    return True


def under_outputs(raw: list[str], number: int) -> bool:
    """True when line `number` sits in a YAML `outputs:` mapping: a value handed on, not pulled."""
    indent = len(raw[number - 1]) - len(raw[number - 1].lstrip())
    for line in reversed(raw[: number - 1]):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        here = len(line) - len(line.lstrip())
        if here < indent:
            return bool(re.match(r"\s*outputs:\s*\Z", line))
    return False


def file_kind(rel: str) -> str:
    name = Path(rel).name.lower()
    suffix = Path(rel).suffix
    if name.startswith(("dockerfile", "containerfile")) or name.endswith((".dockerfile", ".containerfile")):
        return "docker"
    if suffix in YAML_SUFFIXES:
        return "yaml"
    return "code" if suffix in CODE_SUFFIXES else "text"


def docker_words(args: str, instruction: str) -> list[str]:
    try:
        words = shlex.split(args)
    except ValueError:
        words = args.split()
    if instruction == "ENV" and words and "=" not in words[0]:
        words = [f"{words[0]}={' '.join(words[1:])}"]
    return words


def next_scalar(logical: list[tuple[int, str]], index: int) -> tuple[int, str] | None:
    """The value of a YAML key whose scalar is on the following line."""
    if index + 1 >= len(logical):
        return None
    number, text = logical[index + 1]
    value = text.strip().strip("\"'")
    return (number, value) if looks_like_image(value) or value.startswith("$") else None


def parse_file(rel: str, lines: list[str], known: frozenset[str] = frozenset()) -> FileInfo:
    kind = file_kind(rel)
    mode = "shell" if kind != "code" else ("json" if rel.endswith(".json") else "code")
    logical = logical_lines(lines, mode)
    whole = "\n".join(lines)
    env: Env = {}
    defs: list[Def] = []
    anchors: set[str] = set()

    def add(number: int, var: str, value: str, keyed: bool) -> None:
        ok = keyed and definition_ok(var, value, known, whole)
        if ok and kind == "yaml" and under_outputs(lines, number):
            ok = False
        env.setdefault(var, []).append((value, ok))
        if ok:
            defs.append(Def(number, var, value))

    for index, (number, text) in enumerate(logical):
        if kind == "docker":
            m = INSTRUCTION_RE.match(text)
            if m and m["ins"].upper() in ("ARG", "ENV"):
                for word in docker_words(m["args"], m["ins"].upper()):
                    var, eq, value = word.partition("=")
                    if eq:
                        add(number, var, value, bool(KEY_NAME_RE.match(var)))
            continue
        keyed: set[str] = set()
        for key, value in ([] if "GITHUB_OUTPUT" in text else key_definitions(text, kind)):
            keyed.add(key)
            where = number
            if not value or value in BLOCK_INDICATORS:
                nxt = next_scalar(logical, index)
                if not nxt:
                    continue
                where, value = nxt
            add(where, key, value, True)
        assign = SHELL_ASSIGN_RE.match(text) or (YAML_ASSIGN_RE.match(text) if kind == "yaml" else None)
        if assign and assign["name"] not in keyed:
            value, quoted = take_value(assign["rest"])
            if quoted or kind != "code":
                add(number, assign["name"], value, False)
        for m in DEFAULT_REF_RE.finditer(text):
            if has_name(m["ref"]) and looks_like_image(m["ref"]):
                add(number, m["var"], m["ref"], True)
        if kind == "yaml":
            anchors.update(re.findall(r"&([\w-]+)", text))
    return FileInfo(kind, lines, logical, env, defs, anchors)


# ---------------------------------------------------------------------------
# Candidates: the references one file asks Docker to pull.

def command_position(before: str, code: bool) -> bool:
    """True when a docker word after `before` starts a command rather than sitting in prose."""
    b = before.rstrip()
    if not b:
        return True
    if b[-1] in "'\"":
        return not PROSE_CALL.search(b) if code else bool(SHELL_STRING_PREFIX.search(b))
    if b[-1] in ";&|({`!" or YAML_COMMAND_KEY.search(b):
        return True
    words = b.split()
    while words and words[-1] != "-" and ARG_WORD_RE.match(words[-1]):
        words.pop()  # options, a duration, or a FOO=1 assignment before the command
    return not words or words[-1] in COMMAND_WORDS or "sudo" in words[-4:]


def tokens_of(rest: str) -> list[str]:
    """Shell words of `rest`; an unclosed quote (a multi-line `bash -c '`) ends the line there."""
    for _ in range(4):
        try:
            lex = shlex.shlex(rest, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            lex.commenters = ""
            return list(lex)
        except ValueError:
            rest = rest[: max(rest.rfind("'"), rest.rfind('"'))]
    return rest.split()


def image_operand(words: list[str], i: int) -> tuple[str, bool] | None:
    """(operand, certain) for the first positional argument from words[i:].

    `certain` is False when that word is not shaped like an image: the value of
    a flag this guard does not know, or a path. The image may be behind it, so
    it is reported UNRESOLVED rather than accepted.
    """
    while i < len(words):
        raw = words[i]
        i += 1
        if SEPARATOR_RE.match(raw):
            return None
        if raw in VALUE_FLAGS:
            i += 1
            continue
        word = raw.strip("\"'`,;)]}")
        if not word or word.startswith("-"):
            continue
        if "$" in word:
            if FLAG_VAR_RE.search(word):
                continue  # a variable of options, not the image
            return word, True
        if looks_like_image(word) and not word.startswith(("/", ".", "~")):
            return word, True
        if re.search("[=/]", word):
            return word, False  # key=value or a path: what a flag this list does not know would take
        if re.search("[A-Za-z]", word):
            return None  # a prose word, not an operand
        # a bare number: the value of a flag this list does not know; keep looking
    return None


def docker_operands(text: str, code: bool) -> list[tuple[str, bool]]:
    """The image operand of each docker/podman run, create or pull on the line, and whether it is certain."""
    found: list[tuple[str, bool]] = []
    for m in RUNTIME_RE.finditer(text):
        if not command_position(text[: m.start()], code):
            continue
        before = text[: m.start()].rstrip()
        rest = text[m.end():]
        if before[-1:] in ("'", '"', "`") and before[-1] in rest:
            rest = rest.split(before[-1], 1)[0]  # the command is the whole of a quoted string
        words = tokens_of(rest)
        i = 0
        while i < len(words) and words[i].startswith("-"):
            i += 2 if words[i] in GLOBAL_VALUE_FLAGS else 1
        if i < len(words) and words[i] in ("container", "image"):
            i += 1
        if i < len(words) and words[i] in VERBS:
            operand = image_operand(words, i + 1)
            if operand:
                found.append(operand)
    return found


def code_string_candidate(content: str, in_window: bool, known: frozenset[str]) -> str | None:
    if "$" in content:
        return content if in_window and re.match(r"[a-z][a-z0-9._/-]*:\$\{", content) else None
    m = IMAGE_RE.match(content)
    if not m or not re.search("[A-Za-z]", m["repo"]):
        return None
    repo, tag, digest = m["repo"], m["tag"], m["digest"]
    parts = repo.split("/")
    registry = len(parts) > 1 and ("." in parts[0] or ":" in parts[0]) and parts[0].rsplit(".", 1)[-1] not in FILE_EXTENSIONS
    if digest:
        return content
    if tag:
        if PORT_TAG.match(tag) or not CODE_TAG_RE.match(tag):
            return None
        return content if in_window or parts[-1] in known or registry else None
    return content if registry and in_window and len(parts) > 2 else None


def docker_candidates(info: FileInfo, emit) -> None:
    stages: set[str] = set()
    for number, raw in enumerate(info.raw, 1):
        directive = SYNTAX_DIRECTIVE_RE.match(raw)
        if not directive:
            break  # parser directives end at the first comment, blank line or instruction
        if directive["key"].lower() == "syntax":
            emit(number, directive["value"])  # BuildKit pulls this frontend image at build time

    def is_stage(value: str) -> bool:
        return value.lower() in stages or value.isdigit()

    for number, text in info.logical:
        m = INSTRUCTION_RE.match(text)
        if not m:
            continue
        ins, args = m["ins"].upper(), m["args"]
        if ins == "FROM":
            f = FROM_RE.match(f"FROM {args}")
            if f:
                emit(number, f["ref"], lambda v: v == "scratch" or is_stage(v))
                if f["stage"] and STAGE_NAME_RE.match(f["stage"]):
                    stages.add(f["stage"].lower())
        elif ins in ("COPY", "ADD"):
            for ref in re.findall(r"--from=(\S+)", args):
                emit(number, ref, is_stage)
        elif ins == "RUN":
            for mount in re.findall(r"--mount(?:=|\s+)(\S+)", args):
                for part in mount.split(","):
                    if part.startswith("from="):
                        emit(number, part[5:], is_stage)
            for operand, certain in docker_operands(args, False):
                emit(number, operand, certain=certain)


def line_candidates(info: FileInfo, known: frozenset[str], emit) -> None:
    kind = info.kind
    for d in info.defs:
        emit(d.line, d.value, own=d.key)
    for number, text in info.logical:
        if kind == "yaml":
            for m in ANCHOR_RE.finditer(text):
                value = m["value"].strip("\"'")
                if looks_like_image(value) and has_name(value) and not any(d.value == value for d in info.defs):
                    emit(number, value)
        for m in DOCKER_URI_RE.finditer(text):
            emit(number, m["ref"])
        for m in BUILD_ARG_RE.finditer(text):
            value = m["value"]
            if m["name"] not in KEEP_VARS and ((has_name(value) and looks_like_image(value)) or REGISTRY_VAR_START.match(value)):
                emit(number, value)
        for operand, certain in docker_operands(text, kind == "code"):
            emit(number, operand, certain=certain)
        for m in DOCKER_IMAGE_URI_RE.finditer(text):
            emit(number, m["ref"])
        for m in CACHE_FROM_RE.finditer(text):
            emit(number, m["ref"] or m["plain"])
        if kind == "code":
            window = " ".join(info.raw[max(0, number - 13):number]).lower()
            in_window = "docker" in window or "image" in window
            for m in CODE_STRING_RE.finditer(text):
                ref = code_string_candidate(m["ref"], in_window, known)
                if ref:
                    emit(number, ref)


def candidates(
    path: str,
    lines: list[str],
    glob: Env | None = None,
    known: frozenset[str] = frozenset(),
    info: FileInfo | None = None,
) -> list[Cand]:
    """The references this file asks Docker to pull, with the line each is on."""
    info = info or parse_file(path, lines)
    glob = glob or {}
    found: list[Cand] = []

    def emit(number: int, raw: str, skip=None, own: str | None = None, certain: bool = True) -> None:
        raw = raw.strip().strip("\"'").removeprefix("docker://")
        if not raw or raw in ("true", "false", "null", "~"):
            return
        if not certain:
            found.append(Cand(number, raw, True))  # an operand this guard cannot read as an image
            return
        if raw.startswith("*"):
            if raw[1:] not in info.anchors:
                found.append(Cand(number, raw, True))  # an alias whose anchor is not in this file
            return
        out = expand(raw, info.env, glob, frozenset({own}) if own else frozenset())
        if out is None:
            found.append(Cand(number, raw, True))
            return
        values, covered, count = out
        if count and covered:
            return  # every value comes from a definition reported at its own line
        found.extend(Cand(number, v) for v in values if not (skip and skip(v)))

    if info.kind == "docker":
        for d in info.defs:
            emit(d.line, d.value, own=d.key)
        docker_candidates(info, emit)
    else:
        line_candidates(info, known, emit)
    return found


# ---------------------------------------------------------------------------
# The tree.

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
        return full.read_text().lstrip("\ufeff").splitlines()
    except (OSError, UnicodeDecodeError):
        return None


def local_builds(infos: dict[str, FileInfo]) -> frozenset[str]:
    """`name:tag` pairs built in the tree by `docker build -t` (host-less names only)."""
    names: set[str] = set()
    for info in infos.values():
        for _, text in info.logical:
            for m in BUILD_TAG_RE.finditer(text):
                given = m["name"] or (f"${{{m['arg']}}}" if re.fullmatch(r"[A-Za-z_]\w*", m["arg"]) else m["arg"])
                out = expand(given, info.env, {})
                for name in (out[0] if out else []):
                    repo, _, tag = name.rpartition(":") if re.search(r":[^/]*\Z", name) else (name, "", "")
                    first = repo.split("/")[0]
                    if "." in first or ":" in first or first == "localhost":
                        continue
                    names.add(f"{repo}:{tag or 'latest'}")
    return frozenset(names)


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def grants_packages(block: list[str]) -> bool:
    """True when a `permissions:` block (its header first) grants packages read or write."""
    head = re.match(r"\s*permissions:\s*(?P<v>.*)\Z", block[0])
    value = head["v"].strip() if head else ""
    if value in ("read-all", "write-all"):
        return True
    if value.startswith("{"):
        return bool(re.search(r"\bpackages\s*:\s*(read|write)\b", value))
    return any(re.match(r"\s*packages:\s*(read|write)\s*\Z", line) for line in block[1:])


def permissions_block(lines: list[str], lo: int, hi: int, indent: int | None) -> list[str] | None:
    for i in range(lo, hi):
        if re.match(r"\s*permissions:", lines[i]) and (indent is None or indent_of(lines[i]) == indent):
            block = [lines[i]]
            for nxt in lines[i + 1:hi]:
                if nxt.strip() and indent_of(nxt) <= indent_of(lines[i]):
                    break
                block.append(nxt)
            return block
    return None


def override_findings(root: Path, files: list[str]) -> list[Finding]:
    """A workflow that sets IMAGE_REGISTRY must point it at the mirror and be able to pull from it."""
    found: list[Finding] = []
    for rel in sorted(files):
        if not (rel.startswith((".github/workflows/", ".github/actions/")) and rel.endswith((".yml", ".yaml"))):
            continue
        raw = read_text(root, rel) or []
        lines = [strip_hash_comment(line) if not line.strip().startswith("#") else "" for line in raw]
        jobs_at = next((i for i, line in enumerate(lines) if re.match(r"jobs:\s*\Z", line)), None)
        for i, line in enumerate(lines):
            m = OVERRIDE_RE.search(line)
            if not m:
                continue
            value = m["value"]
            if value.startswith("${{"):
                found.append(Finding(rel, i + 1, value, UNRESOLVED, "UNRESOLVED reference: the override is an expression; it must be ghcr.io/branchleft/mirror"))
                continue
            if value != MIRROR_REGISTRY:
                found.append(Finding(rel, i + 1, value, "bad-override", f"CI override must be {MIRROR_REGISTRY}"))
                continue
            top = permissions_block(lines, 0, jobs_at if jobs_at is not None else len(lines), 0)
            granted = bool(top and grants_packages(top))
            if jobs_at is not None and i > jobs_at:
                job_indent = next((indent_of(x) for x in lines[jobs_at + 1:] if x.strip()), 2)
                start = max(
                    (k for k in range(jobs_at + 1, i + 1) if lines[k].strip() and indent_of(lines[k]) == job_indent),
                    default=jobs_at + 1,
                )
                end = next(
                    (k for k in range(start + 1, len(lines)) if lines[k].strip() and indent_of(lines[k]) <= job_indent),
                    len(lines),
                )
                own = permissions_block(lines, start + 1, end, job_indent + 2)
                granted = grants_packages(own) if own else granted
            if not granted:
                found.append(
                    Finding(rel, i + 1, value, "override-no-permission", "workflow sets the mirror but lacks packages: read")
                )
    return found


def known_names(mirror: set[tuple[str, str]]) -> frozenset[str]:
    return frozenset(WELL_KNOWN_NAMES | {source.rsplit("/", 1)[-1] for source, _ in mirror})


def scan(root: Path, mirror: set[tuple[str, str]], allow: list[str]) -> list[Finding]:
    files = tracked_files(root)
    findings: list[Finding] = override_findings(root, files)
    known = known_names(mirror)
    infos: dict[str, FileInfo] = {}
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
        infos[rel] = parse_file(rel, lines, known)
    glob: Env = {}
    for info in infos.values():
        for d in info.defs:
            glob.setdefault(d.key, []).append((d.value, True))
    local = local_builds(infos)
    unresolved_seen: set[tuple[str, str]] = set()
    for rel, info in infos.items():
        seen: set[tuple[int, str]] = set()
        for cand in candidates(rel, info.raw, glob, known, info):
            if (cand.line, cand.ref) in seen:
                continue
            seen.add((cand.line, cand.ref))
            if cand.unresolved:
                if (rel, cand.ref) in unresolved_seen:
                    continue  # one line per file and expression
                unresolved_seen.add((rel, cand.ref))
                findings.append(
                    Finding(rel, cand.line, cand.ref, UNRESOLVED, "UNRESOLVED reference: its value is not in the repo, so what it pulls cannot be checked")
                )
                continue
            verdict = classify(cand.ref, mirror, local)
            if verdict:
                findings.append(Finding(rel, cand.line, cand.ref, *verdict))
    return findings


def load_policy(path: Path) -> tuple[set[tuple[str, str]], list[str]]:
    data = json.loads(path.read_text())
    mirror = {(e["source"], e["digest"]) for e in data["images"]}
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
    unresolved = sum(1 for f in findings if f.kind == UNRESOLVED)
    print(f"image-refs: {len(findings) - unresolved} reference(s) not on the mirror, {unresolved} UNRESOLVED (mode {mode})")
    return 1 if findings and mode == "enforce" else 0


DIGEST_A = "sha256:" + "a" * 64
SELF_LIST = {
    "registry": MIRROR_REGISTRY,
    "images": [{"name": "ghost", "source": "docker.io/library/ghost", "digest": DIGEST_A}],
}
GOOD_REF = f"${{IMAGE_REGISTRY:-docker.io/library}}/ghost:6@{DIGEST_A}"
WORKFLOW_HEAD = "permissions:\n  packages: read\njobs:\n  t:\n    env:\n"


def self_test() -> int:
    """Each sabotage must go red in enforce mode, then a clean tree green."""
    cases = {
        "FROM ghost": ({"Dockerfile": "FROM ghost:6.55.0-alpine\n"}, ["unqualified"]),
        "tag-only reference": (
            {"Dockerfile": "FROM ${IMAGE_REGISTRY:-docker.io/library}/ghost:6.55.0-alpine\n"},
            ["tag-only"],
        ),
        "digest with no tag": ({"Dockerfile": f"FROM ${{IMAGE_REGISTRY:-docker.io/library}}/ghost@{DIGEST_A}\n"}, ["no-tag"]),
        "hard-coded mirror reference": ({"Dockerfile": f"FROM ghcr.io/branchleft/mirror/ghost@{DIGEST_A}\n"}, ["hard-coded-mirror"]),
        "wrong public default": (
            {"Dockerfile": f"FROM ${{IMAGE_REGISTRY:-docker.io/elsewhere}}/ghost:6@{DIGEST_A}\n"},
            ["bad-default"],
        ),
        "image held in an ARG": ({"Dockerfile": "ARG BASE=node:20\nFROM ${BASE}\n"}, ["unqualified"]),
        "tag held in an ARG": ({"Dockerfile": "ARG V=20\nFROM node:${V}-alpine\n"}, ["unqualified"]),
        "FROM across a continuation": ({"Dockerfile": "FROM \\\n  node:20\n"}, ["unqualified"]),
        "COPY --from an image": ({"Dockerfile": "FROM scratch\nCOPY --from=node:20 /a /b\n"}, ["unqualified"]),
        "RUN --mount from an image": (
            {"Dockerfile": "FROM scratch\nRUN --mount=type=bind,from=postgres:17,target=/x true\n"},
            ["unqualified"],
        ),
        "dotted-quad registry": ({"Dockerfile": "FROM 203.0.113.9:5000/evil/img:1\n"}, ["other-registry"]),
        "unqualified workflow service image": (
            {".github/workflows/ci.yml": "jobs:\n  t:\n    services:\n      db:\n        image: postgres:17-alpine\n"},
            ["unqualified"],
        ),
        "workflow IMAGE env then docker run": (
            {".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - env:\n          IMAGE: postgres:17\n        run: docker run \"$IMAGE\"\n"},
            ["unqualified"],
        ),
        "image held in a shell variable": ({"t.sh": 'IMG=alpine:3.19\ndocker run --rm "$IMG" true\n'}, ["unqualified"]),
        "variable with no value in the repo": ({"t.sh": 'docker run --rm "$IMG" true\n'}, [UNRESOLVED]),
        "unknown numeric value flag": ({"t.sh": "docker run --cpu-shares 512 mysql:8.0 true\n"}, ["unqualified"]),
        "podman run": ({"t.sh": "podman run --rm alpine:3.19 true\n"}, ["unqualified"]),
        "syntax directive": ({"Dockerfile": "# syntax=docker/dockerfile:1\nFROM scratch\n"}, ["docker.io"]),
        "env prefix before docker": ({"t.sh": "FOO=1 timeout 60 docker run --rm alpine:3.19\n"}, ["unqualified"]),
        "unknown flag with a key=value": (
            {"t.sh": "docker run --ulimit nofile=1024:2048 alpine:3.19\n"},
            [UNRESOLVED],
        ),
        "build context image": ({"t.sh": "docker buildx build --build-context b=docker-image://alpine:3 .\n"}, ["unqualified"]),
        "build -t to a foreign registry": (
            {"t.sh": "docker build -t quay.io/evil/x:1 .\ndocker run quay.io/evil/x:1\n"},
            ["other-registry"],
        ),
        "override to somewhere else": (
            {".github/workflows/ci.yml": WORKFLOW_HEAD + "      IMAGE_REGISTRY: docker.io/library\n"},
            ["bad-override"],
        ),
        "override without packages: read": (
            {".github/workflows/ci.yml": f"jobs:\n  t:\n    env:\n      IMAGE_REGISTRY: {MIRROR_REGISTRY}\n"},
            ["override-no-permission"],
        ),
    }
    clean = {
        "Dockerfile": f"ARG IMAGE_REGISTRY\nFROM {GOOD_REF}\nFROM scratch\n",
        ".github/workflows/ci.yml": WORKFLOW_HEAD
        + f"      IMAGE_REGISTRY: {MIRROR_REGISTRY}\n    steps:\n      - run: docker build -t app:ci .\n"
        + "      - run: docker run --rm --stop-signal SIGKILL app:ci\n",
    }
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        policy = Path(tmp) / "list.json"
        policy.write_text(json.dumps(SELF_LIST))
        mirror, allow = load_policy(policy)
        for label, (files, kinds) in cases.items():
            root = Path(tmp) / label.replace(" ", "-").replace(":", "")
            for rel, text in files.items():
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_text(text)
            got = [f.kind for f in scan(root, mirror, allow)]
            red = got == kinds
            print(f"{'ok  ' if red else 'FAIL'} sabotage red: {label} -> {got}")
            failures += 0 if red else 1
        root = Path(tmp) / "clean"
        for rel, text in clean.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text)
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
