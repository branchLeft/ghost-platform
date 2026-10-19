#!/usr/bin/env python3
"""Decide whether a Pulumi plan changes anything: only a clean plan is `false`.
The rules and their reasons are in plan-has-changes.md beside this file."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import stat
import sys
from typing import NamedTuple

ROOT_STACK_TYPE = "pulumi:pulumi:Stack"
SAME = "same"
MAX_DEPTH = 500

# The keys each level of the two files may carry: those seen in a real plan and
# preview, plus the preview step's own fields. Any other key is a shape change.
PREVIEW_KEYS = frozenset({"config", "steps", "duration", "changeSummary", "diagnostics", "maybeCorrupt"})
PLAN_KEYS = frozenset({"manifest", "config", "resourcePlans"})
STEP_KEYS = frozenset({"op", "urn", "provider", "oldState", "newState", "detailedDiff", "diffReasons", "replaceReasons"})
ENTRY_KEYS = frozenset({"goal", "steps", "state", "seed"})
GOAL_KEYS = frozenset(
    {"type", "name", "custom", "inputDiff", "outputDiff", "parent", "protect", "provider", "propertyDependencies", "customTimeouts"}
)

# A `same` step that carries any of these, non-empty, is not a no-op.
STEP_DIFF_KEYS = ("detailedDiff", "diffReasons", "replaceReasons")
# Every state key is compared exactly, a missing one reading as null, except:
# id and outputs, compared only when both sides hold them (a real new state is
# read before it copies the old ones); sourcePosition and stackTrace, never.
OLD_SIDE_STATE_KEYS = frozenset({"id", "outputs"})
DIAGNOSTIC_STATE_KEYS = frozenset({"sourcePosition", "stackTrace"})
# The engine never emits `same` for these, so any truthy one on either side is a change.
FLAG_STATE_KEYS = ("taint", "pendingReplacement", "delete", "initErrors")
# How a secret shows up: in a plan, an object holding the signature key; in the preview, the placeholder.
SECRET_SIG_KEY = "4dabf18193072939515e22adb298388d"
SECRET_PLACEHOLDER = "[secret]"
# A key or type name is reported in the summary only if it is plain; at most this many are named.
NAME_PATTERN = re.compile(r"[A-Za-z0-9_.:/$-]{1,80}\Z")
MAX_NAMES = 20
# What the output diff and the input diff may carry, with each JSON type.
DIFF_KEYS = {"adds": dict, "updates": dict, "deletes": list}

HEADLINE_NO_CHANGES = "No changes: the apply job is skipped and no approval is requested"
HEADLINE_NOT_UNDERSTOOD = "Plan not understood, treated as changes: approval required"
COUNTED_REASONS = {"steps-changed", "summary-changed", "output-changed"}


class Verdict(NamedTuple):
    has_changes: bool
    count: int
    reason: str
    detail: str = ""


class Urn(NamedTuple):
    stack: str
    project: str
    type: str
    name: str


class Preview(NamedTuple):
    """What a clean preview gives the plan check: its root stack and each listed new state."""

    root: Urn
    new_states: dict[str, dict[str, object]]
    root_outputs: dict[str, object]


NO_CHANGES = Verdict(False, 0, "no-changes")


class Unclear(Exception):
    """An input is not a shape this script understands. `reason` is its code and
    `detail` names what was not understood (key and type names, never values)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise Unclear(reason)


def _names(values: set[str]) -> str:
    """Plain, sorted, de-duplicated names for the summary; anything odd is not echoed."""
    unique = sorted({v if NAME_PATTERN.match(v) and "::" not in v else "<odd name>" for v in values})
    shown = unique[:MAX_NAMES]
    more = len(unique) - len(shown)
    return ", ".join(shown) + (f" and {more} more" if more else "")


def _as_dict(value: object, reason: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise Unclear(reason)
    return value


def _no_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    if len({key for key, _ in pairs}) != len(pairs):
        raise ValueError("duplicate key")
    return dict(pairs)


def _no_constant(name: str) -> object:
    raise ValueError(name)


def _finite(text: str) -> float:
    """A JSON number that overflows to infinity is refused, like `NaN` and `Infinity`."""
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(text)
    return value


def _too_deep(doc: object) -> bool:
    """Whether the document nests deeper than MAX_DEPTH, measured without recursion."""
    stack = [(doc, 1)]
    while stack:
        node, depth = stack.pop()
        if isinstance(node, (dict, list)):
            if depth > MAX_DEPTH:
                return True
            children = node.values() if isinstance(node, dict) else node
            stack.extend((child, depth + 1) for child in children)
    return False


def _load(path: str, reason: str) -> object:
    """Parse a JSON file, or raise Unclear for every way it can fail."""
    try:
        with open(path, encoding="utf-8") as handle:
            doc = json.load(
                handle, object_pairs_hook=_no_duplicates, parse_constant=_no_constant, parse_float=_finite
            )
    except (OSError, ValueError, RecursionError) as error:
        raise Unclear(reason) from error
    _require(not _too_deep(doc), reason)
    return doc


def _parse_urn(urn: object, reason: str) -> Urn:
    """Split `urn:pulumi:<stack>::<project>::<type>::<name>`; a `::` in the name is refused."""
    _require(isinstance(urn, str), reason)
    parts = str(urn).split("::", 3)
    _require(len(parts) == 4 and parts[0].startswith("urn:pulumi:"), reason)
    _require("::" not in parts[3], reason)
    return Urn(parts[0][len("urn:pulumi:") :], parts[1], parts[2], parts[3])


def _urn_text(urn: Urn) -> str:
    return f"urn:pulumi:{urn.stack}::{urn.project}::{urn.type}::{urn.name}"


def _is_root(urn: Urn) -> bool:
    """The stack's own root: the exact root type, named `<project>-<stack>`."""
    return urn.type == ROOT_STACK_TYPE and urn.name == f"{urn.project}-{urn.stack}"


def _leaf_type(urn: Urn) -> str:
    return urn.type.rsplit("$", 1)[-1]


def _stacks(urns: list[Urn]) -> list[Urn]:
    """Every resource whose own type is the stack type, nested under a parent type or not."""
    return [urn for urn in urns if _leaf_type(urn) == ROOT_STACK_TYPE]


def _has_one_root(urns: list[Urn]) -> bool:
    """Exactly one stack-typed resource, and it is the root: a second one is anomalous."""
    stacks = _stacks(urns)
    return len(stacks) == 1 and _is_root(stacks[0])


def _check_keys(doc: dict[str, object], known: frozenset[str], reason: str, level: str) -> None:
    unknown = set(doc) - known
    if unknown:
        raise Unclear(reason, f"unrecognised {level} key(s): {_names(unknown)}")


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _evidence(value: object) -> bool:
    """Absent, null and empty hold no evidence; non-empty does; any other type is Unclear."""
    if value is None:
        return False
    if isinstance(value, (list, dict)):
        return bool(value)
    raise Unclear("preview-shape")


def _is_secret(value: object) -> bool:
    return isinstance(value, dict) and SECRET_SIG_KEY in value


def _same_value(first: object, second: object, secrets: bool = False) -> bool:
    """JSON equality by type and value: a boolean is never a number, a null never an absent
    key. Numbers compare by value. With `secrets`, a plan secret facing a secret or the preview's placeholder is skipped;
    a secret against a plain value, or a placeholder against one, differs."""
    pending = [(first, second)]
    while pending:
        a, b = pending.pop()
        if secrets and _is_secret(a) and (b == SECRET_PLACEHOLDER or _is_secret(b)):
            continue
        if isinstance(a, bool) or isinstance(b, bool):
            if not (isinstance(a, bool) and isinstance(b, bool) and a == b):
                return False
        elif isinstance(a, dict) and isinstance(b, dict):
            if a.keys() != b.keys():
                return False
            pending.extend((a[key], b[key]) for key in a)
        elif isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                return False
            pending.extend(zip(a, b))
        elif isinstance(a, (dict, list)) or isinstance(b, (dict, list)) or a != b:
            return False
    return True


def _states_differ(old: dict[str, object], new: dict[str, object]) -> bool:
    """Whether a `same` step's old and new state disagree on any key."""
    for key in (old.keys() | new.keys()) - DIAGNOSTIC_STATE_KEYS:
        if key in OLD_SIDE_STATE_KEYS and not (key in old and key in new):
            continue
        if not _same_value(old.get(key), new.get(key)):
            return True
    return False


def _is_provider_type(token: object) -> bool:
    """The engine's IsProviderType: exactly `pulumi:providers:<package>` (reference.go 40-46)."""
    parts = token.split(":") if isinstance(token, str) else []
    return len(parts) == 3 and parts[:2] == ["pulumi", "providers"] and bool(parts[2])


def _lacks_provider(new: dict[str, object]) -> bool:
    """A custom resource that is not itself a provider must carry one (NewSameStep)."""
    return new.get("custom") is True and not _is_provider_type(new.get("type")) and not new.get("provider")


def _state_is_unfit(urn: Urn, state: dict[str, object]) -> bool:
    """A state the engine would not write for a `same` step: `custom` not a boolean, a
    state flag set, or a `type` that is not the URN's own."""
    return (
        not isinstance(state.get("custom"), bool)
        or any(state.get(key) for key in FLAG_STATE_KEYS)
        or ("type" in state and state["type"] != _leaf_type(urn))
    )


def _same_step_differs(urn: Urn, step: dict[str, object]) -> bool:
    """Whether a `same` step carries its own evidence of a difference."""
    _check_keys(step, STEP_KEYS, "preview-shape", "preview step")
    evidence = [_evidence(step.get(key)) for key in STEP_DIFF_KEYS]
    old, new = step.get("oldState"), step.get("newState")
    if not (isinstance(old, dict) and isinstance(new, dict)):
        raise Unclear("preview-shape")
    unfit = _state_is_unfit(urn, old) or _state_is_unfit(urn, new)
    return any(evidence) or unfit or _lacks_provider(new) or _states_differ(old, new)


def _preview_steps(doc: dict[str, object]) -> list[tuple[str, Urn, dict[str, object]]]:
    steps = doc.get("steps")
    if not isinstance(steps, list) or not steps:
        raise Unclear("preview-shape")
    found = []
    for step in steps:
        entry = _as_dict(step, "preview-shape")
        op = entry.get("op")
        _require(isinstance(op, str), "preview-shape")
        found.append((str(op), _parse_urn(entry.get("urn"), "preview-shape"), entry))
    return found


def _summary_verdict(doc: dict[str, object], same_steps: int) -> Verdict | None:
    """The change summary must count nothing but `same`, and at least the `same` steps listed."""
    summary = _as_dict(doc.get("changeSummary"), "preview-shape")
    for value in summary.values():
        _require(_is_count(value), "preview-shape")
    changed = max((int(v) for k, v in summary.items() if k != SAME and isinstance(v, int)), default=0)
    if changed:
        return Verdict(True, changed, "summary-changed")
    same_count = summary.get(SAME, 0)
    _require(isinstance(same_count, int) and same_count >= same_steps, "preview-shape")
    return None


def _preview_verdict(path: str) -> tuple[Verdict | None, Preview | None]:
    """(a `true` verdict, None) if the preview JSON shows anything but a clean no-op,
    else (None, what the plan is checked against)."""
    doc = _as_dict(_load(path, "preview-unreadable"), "preview-shape")
    _check_keys(doc, PREVIEW_KEYS, "preview-shape", "preview")
    steps = _preview_steps(doc)
    changed = sum(1 for op, _, _ in steps if op != SAME)
    if changed:
        return Verdict(True, changed, "steps-changed"), None
    # After the op check: a replace lists one URN in several steps, and that is a change.
    _require(len({urn for _, urn, _ in steps}) == len(steps), "preview-shape")
    differing = sum(1 for _, urn, step in steps if _same_step_differs(urn, step))
    if differing:
        return Verdict(True, differing, "steps-changed"), None
    urns = [urn for _, urn, _ in steps]
    if not _has_one_root(urns):
        return Verdict(True, 0, "no-root-stack"), None
    _require("config" not in doc or isinstance(doc["config"], dict), "preview-shape")
    _require("duration" not in doc or _is_count(doc["duration"]), "preview-shape")
    diagnostics = doc.get("diagnostics")
    _require(diagnostics is None or (isinstance(diagnostics, list) and not diagnostics), "preview-diagnostics")
    corrupt = doc.get("maybeCorrupt")
    _require(corrupt is None or corrupt is False, "preview-shape")
    states = {str(entry["urn"]): entry["newState"] for _, _, entry in steps}
    root = _stacks(urns)[0]
    root_old = next(entry["oldState"] for _, urn, entry in steps if urn == root)
    outputs = root_old.get("outputs", {})  # type: ignore[union-attr]
    _require(isinstance(outputs, dict), "preview-shape")
    return _summary_verdict(doc, len(steps)), Preview(root, states, outputs)


def _diff_size(diff: object) -> int:
    """How many keys an adds/updates/deletes diff holds; null or odd types are Unclear."""
    entries = _as_dict(diff, "plan-shape")
    _check_keys(entries, frozenset(DIFF_KEYS), "plan-shape", "diff")
    total = 0
    for key, kind in DIFF_KEYS.items():
        if key in entries:
            value = entries[key]
            _require(isinstance(value, kind), "plan-shape")
            total += len(value)  # type: ignore[arg-type]
    return total


def _planned_steps(entry: dict[str, object]) -> int:
    """How many of an entry's planned steps are not `same`; absent or empty is Unclear."""
    steps = entry.get("steps")
    _require(isinstance(steps, list) and bool(steps), "plan-shape")
    _require(all(isinstance(op, str) for op in steps), "plan-shape")  # type: ignore[union-attr]
    return sum(1 for op in steps if op != SAME)  # type: ignore[union-attr]


def _parent_is_clean(urn: Urn, goal: dict[str, object], plan_urns: dict[str, object]) -> bool:
    """A goal's parent is another entry of the plan whose type chain builds this URN's type.

    No parent is clean only for a type with no parent in its chain (no `$`)."""
    if "parent" not in goal:
        return "$" not in urn.type
    parent = goal["parent"]
    if not isinstance(parent, str) or parent not in plan_urns:
        return False
    owner = _parse_urn(parent, "plan-shape")
    leaf = _leaf_type(urn)
    expected = leaf if _is_root(owner) else f"{owner.type}${leaf}"
    return (owner.stack, owner.project, expected) == (urn.stack, urn.project, urn.type)


def _goal_fields_are_clean(urn: Urn, goal: dict[str, object], plan_urns: dict[str, object]) -> bool:
    """Every goal field other than the diffs holds the value a clean plan carries, or is absent."""
    return (
        goal.get("type", _leaf_type(urn)) == _leaf_type(urn)
        and goal.get("name", urn.name) == urn.name
        and isinstance(goal.get("custom", False), bool)
        and isinstance(goal.get("protect", False), bool)
        and goal.get("customTimeouts", {}) == {}
        and _provider_is_clean(goal)
        and _property_dependencies_are_clean(goal)
        and _parent_is_clean(urn, goal, plan_urns)
    )


def _provider_is_clean(goal: dict[str, object]) -> bool:
    return "provider" not in goal or (isinstance(goal["provider"], str) and bool(goal["provider"]))


def _property_dependencies_are_clean(goal: dict[str, object]) -> bool:
    """A map from property name to a list of URN strings, as the real plan writes it."""
    deps = goal.get("propertyDependencies", {})
    if not isinstance(deps, dict):
        return False
    return all(isinstance(v, list) and all(isinstance(u, str) for u in v) for v in deps.values())


def _goal_agrees_with_preview(goal: dict[str, object], state: dict[str, object]) -> bool:
    """Where the preview lists the resource, the goal says what its new state says."""
    return (
        bool(goal.get("custom", False)) == bool(state.get("custom", False))
        and goal.get("parent") == state.get("parent")
        and goal.get("provider") == state.get("provider")
        and not state.get("protect")
    )


def _note(findings: dict[str, set[str]], label: str, names: set[str]) -> None:
    """Record names for the plan-shape detail; every entry is read before it is raised."""
    if names:
        findings.setdefault(label, set()).update(names)


def _entry_changes(
    urn: Urn, entry: dict[str, object], plan_urns: dict[str, object], preview: Preview, findings: dict[str, set[str]]
) -> tuple[int, int]:
    """(output changes, other changes) for one planned resource."""
    _note(findings, "unrecognised plan entry key(s)", set(entry) - ENTRY_KEYS)
    other = _planned_steps(entry)
    _require("seed" not in entry or isinstance(entry["seed"], str), "plan-shape")
    _require("state" not in entry or isinstance(entry["state"], dict), "plan-shape")
    goal = _as_dict(entry.get("goal"), "plan-shape")
    _note(findings, "unrecognised goal key(s)", set(goal) - GOAL_KEYS)
    _require("outputDiff" in goal and "inputDiff" in goal, "plan-shape")
    _require(_goal_fields_are_clean(urn, goal, plan_urns), "plan-shape")
    if goal.get("protect"):
        _note(findings, "protect is true on resource type(s)", {_leaf_type(urn)})
    listed = preview.new_states.get(_urn_text(urn))
    _require(listed is None or _goal_agrees_with_preview(goal, listed), "plan-shape")
    other += _diff_size(goal["inputDiff"])
    return _diff_size(goal["outputDiff"]), other


def _root_output_changes(state: object, old_outputs: dict[str, object]) -> int:
    """Plain keys of the root's plan state that differ from the preview's old outputs.

    A secret is skipped (ciphertext in the plan, a placeholder in the preview); a key
    on one side only is the output diff's to report."""
    new_outputs = state if isinstance(state, dict) else {}
    shared = new_outputs.keys() & old_outputs.keys()
    return sum(1 for key in shared if not _same_value(new_outputs[key], old_outputs[key], secrets=True))


def _plan_verdict(path: str, preview: Preview) -> Verdict:
    """The verdict from the update plan, every entry checked, the root stack's included.

    `preview` is the clean preview: the plan must be for the same stack."""
    doc = _as_dict(_load(path, "plan-unreadable"), "plan-shape")
    _check_keys(doc, PLAN_KEYS, "plan-shape", "plan")
    for key in ("manifest", "config"):
        _require(key not in doc or isinstance(doc[key], dict), "plan-shape")
    plans = _as_dict(doc.get("resourcePlans"), "plan-shape")
    _require(bool(plans), "plan-shape")
    entries = [(_parse_urn(key, "plan-shape"), _as_dict(value, "plan-shape")) for key, value in plans.items()]
    urns = [urn for urn, _ in entries]
    _require(_has_one_root(urns), "plan-shape")
    _require(_stacks(urns)[0] == preview.root, "stack-mismatch")
    findings: dict[str, set[str]] = {}
    results = [_entry_changes(urn, entry, plans, preview, findings) for urn, entry in entries]
    if findings:
        raise Unclear("plan-shape", "; ".join(f"{label}: {_names(names)}" for label, names in findings.items()))
    root_entry = plans[_urn_text(preview.root)]
    outputs = sum(out for out, _ in results) + _root_output_changes(root_entry.get("state"), preview.root_outputs)  # type: ignore[attr-defined]
    other = sum(rest for _, rest in results)
    if outputs:
        return Verdict(True, outputs, "output-changed")
    if other:
        return Verdict(True, other, "steps-changed")
    return NO_CHANGES


def _same_file(first: str, second: str) -> bool:
    try:
        return os.path.samefile(first, second)
    except OSError:
        return False


def evaluate(preview_path: str, plan_path: str) -> Verdict:
    """The verdict for a preview JSON file and its saved plan file.

    Fails closed: a shape not understood, or any error, is a `true` with a reason code."""
    try:
        if _same_file(preview_path, plan_path):
            return Verdict(True, 0, "same-file")
        verdict, clean_preview = _preview_verdict(preview_path)
        if verdict is not None:
            return verdict
        _require(clean_preview is not None, "internal-error")
        return _plan_verdict(plan_path, clean_preview)  # type: ignore[arg-type]
    except Unclear as unclear:
        return Verdict(True, 0, unclear.reason, unclear.detail)
    except Exception:  # noqa: BLE001 -- every failure must reach the gate
        return Verdict(True, 0, "internal-error")


def headline(verdict: Verdict) -> str:
    """The first line of the plan job's summary."""
    if not verdict.has_changes:
        return HEADLINE_NO_CHANGES
    if verdict.reason in COUNTED_REASONS and verdict.count > 0:
        noun = "change" if verdict.count == 1 else "changes"
        return f"{verdict.count} {noun}: approval required"
    return HEADLINE_NOT_UNDERSTOOD


def reason_line(verdict: Verdict) -> str:
    """The summary's second line: the reason code and what was not understood, or empty."""
    return f"{verdict.reason}: {verdict.detail}\n" if verdict.detail else ""


def _path_problem(flag: str, path: str) -> str | None:
    """Why an output path cannot carry the verdict: blank, or an existing non-regular file."""
    if not path.strip():
        return f"{flag} names no file, so the plan verdict cannot be published"
    if os.path.islink(path) and not os.path.exists(path):
        return f"{flag} is a symlink to a missing target, so the plan verdict cannot be published"
    if os.path.exists(path) and not stat.S_ISREG(os.stat(path).st_mode):
        return f"{flag} is not a regular file, so the plan verdict cannot be published"
    return None


def _output_problem(output: str, summary: str) -> str | None:
    """Why the two output paths cannot be written, or None."""
    problem = _path_problem("--github-output", output) or _path_problem("--github-summary", summary)
    same_name = os.path.realpath(output) == os.path.realpath(summary)
    if problem is None and (same_name or _same_file(output, summary)):
        return "--github-output and --github-summary name the same file, so the verdict would be mangled"
    return problem


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="plan-has-changes.py", description=__doc__.split("\n")[0])
    parser.add_argument("preview_json")
    parser.add_argument("plan_file")
    parser.add_argument("--github-output", required=True, help="append has_changes=<bool> to this file")
    parser.add_argument("--github-summary", required=True, help="append the headline to this file")
    args = parser.parse_args(argv[1:])

    problem = _output_problem(args.github_output, args.github_summary)
    if problem:
        print(f"::error::{problem}")
        return 1

    verdict = evaluate(args.preview_json, args.plan_file)
    text = "true" if verdict.has_changes else "false"
    try:
        with open(args.github_output, "a", encoding="utf-8") as handle:
            handle.write(f"has_changes={text}\n")
        with open(args.github_summary, "a", encoding="utf-8") as handle:
            handle.write(f"{headline(verdict)}\n{reason_line(verdict)}\n")
    except OSError as error:
        print(f"::error::cannot write the plan verdict: {type(error).__name__}")
        return 1

    print(f"has_changes={text} reason={verdict.reason} count={verdict.count}")
    if verdict.detail:
        print(reason_line(verdict).strip())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
