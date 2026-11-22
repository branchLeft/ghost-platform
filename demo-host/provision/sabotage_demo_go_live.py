#!/usr/bin/env python3
"""Sabotage proof for demo_go_live and demo_verdict_evidence: break each refusal
in a scratch copy and require the suite red, then the untouched copy green. The
scratch copy mirrors the repository paths the suite reads (this directory and
the broker's spec and status handler), so a sabotage can drop the verdict field
from the broker's answer as well as from the go-live step.

Usage: sabotage_demo_go_live.py
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
PROVISION = "demo-host/provision"
GO_LIVE = f"{PROVISION}/demo_go_live.py"
EVIDENCE = f"{PROVISION}/demo_verdict_evidence.py"
BROKER_FILES = ("services/broker/openapi.yaml", "services/broker/src/app.ts")

# (name, old text, new text[, repo-relative file]) -- the file defaults to
# demo_go_live.py.
SABOTAGES: list[tuple[str, ...]] = [
    ("drop the stand-in refusal (a stand-in-loaded broker opens)",
     '            elif names:\n                reasons.append(f"slot {slot}: {why}: {\', \'.join(_clean(n) for n in sorted(names))}")\n',
     ""),
    ("stop at the first offending slot (only its stand-ins are named)",
     '            elif names:\n                reasons.append(f"slot {slot}: {why}: {\', \'.join(_clean(n) for n in sorted(names))}")\n',
     '            elif names:\n                raise GoLiveRefused(f"slot {slot}: {why}: {\', \'.join(_clean(n) for n in sorted(names))}")\n'),
    ("ignore interim modules",
     '(("notReal", "test stand-in loaded"), ("interim", "interim module loaded"))',
     '(("notReal", "test stand-in loaded"),)'),
    ("treat a missing list as clean",
     "if not isinstance(names, list) or not all(isinstance(n, str) for n in names):",
     "if False:"),
    ("treat an unreachable broker as clean",
     '        reasons.append(f"slot {slot}: broker status unreadable ({type(error).__name__})")\n        return None\n',
     '        return {"notReal": [], "interim": [], "productionVerdictSource": True}\n'),
    ("treat a body that is not an object as clean",
     '        reasons.append(f"slot {slot}: broker status is not an object")\n        return None\n',
     '        return {"notReal": [], "interim": [], "productionVerdictSource": True}\n'),
    ("skip the clock check",
     "if not (clock or clock_is_synchronised)():",
     "if False:"),
    ("clock reader always says synchronised",
     '    return result.returncode == 0 and result.stdout.strip() == "yes"',
     "    return True"),
    ("clock reader ignores a non-zero exit",
     '    return result.returncode == 0 and result.stdout.strip() == "yes"',
     '    return result.stdout.strip() == "yes"'),
    ("missing timedatectl counts as synchronised",
     "    except (OSError, subprocess.TimeoutExpired):\n        return False\n",
     "    except (OSError, subprocess.TimeoutExpired):\n        return True\n"),
    ("broker reader blanks the stand-in lists",
     "        return json.loads(response.read())\n",
     "        body = json.loads(response.read())\n        body.update(notReal=[], interim=[])\n        return body\n"),
    ("broker reader asks the wrong slot",
     'url = f"{broker_url.rstrip(\'/\')}/status/{slot}"',
     'url = f"{broker_url.rstrip(\'/\')}/status/0"'),
    ("check only slot 0",
     "    for slot in slots:\n        status = _read_status(broker_url, slot, fetch, reasons)\n        if status is None:\n            continue\n        for key, why",
     "    for slot in slots[:1]:\n        status = _read_status(broker_url, slot, fetch, reasons)\n        if status is None:\n            continue\n        for key, why"),
    ("echo module names unsanitised",
     "', '.join(_clean(n) for n in sorted(names))",
     "', '.join(sorted(names))"),
    ("let an empty slots sequence pass the seam check",
     '    reasons: list[str] = []\n    if not slots:\n        raise GoLiveRefused("no slots to check, so nothing was verified")\n',
     "    reasons: list[str] = []\n"),
    ("let an empty slots sequence pass the verdict check",
     '    if not slots:\n        raise GoLiveRefused("no slots to check, so nothing was verified")\n    reasons: list[str] = []\n',
     "    reasons: list[str] = []\n"),
    ("install before the check",
     "    check_seams(broker_url, fetch=fetch or fetch_status)\n",
     "    write_generated_file(install_path, open(caddyfile_src, encoding='utf-8').read())\n    check_seams(broker_url, fetch=fetch or fetch_status)\n"),
    ("go-live ignores the verdict source (an unwired demo opens)",
     "{', '.join(_clean(n) for n in sorted(names))}\")\n        reasons.extend(verdict_source_reasons(slot, status))\n",
     "{', '.join(_clean(n) for n in sorted(names))}\")\n"),
    ("the verdict check passes a status that reports `false`",
     "    if status[VERDICT_KEY] is not True:",
     "    if False:"),
    ("the verdict check passes a status that does not report the field",
     "    if VERDICT_KEY not in status:\n",
     "    if VERDICT_KEY not in status:\n        return []\n    if False:\n"),
    ("the verdict check accepts any truthy value, not only `true`",
     "    if status[VERDICT_KEY] is not True:",
     "    if not status[VERDICT_KEY]:"),
    ("the verdict check reads the wrong field",
     'VERDICT_KEY = "productionVerdictSource"',
     'VERDICT_KEY = "verdictSource"'),
    ("the evidence check ignores the verdict source (unwired evidence passes)",
     "        if status is None:\n            continue\n        reasons.extend(verdict_source_reasons(slot, status))\n",
     "        if status is None:\n            continue\n"),
    ("the evidence check stops reading the slots",
     "    for slot in slots:\n        status = _read_status(broker_url, slot, fetch, reasons)\n        if status is None:\n            continue\n        reasons.extend(",
     "    for slot in ():\n        status = _read_status(broker_url, slot, fetch, reasons)\n        if status is None:\n            continue\n        reasons.extend("),
    ("the evidence command prints success whatever the check said",
     "        check_verdict_source(args.broker_url)\n",
     "        pass\n",
     EVIDENCE),
    ("the evidence command exits 0 on a refusal",
     "        return 1\n",
     "        return 0\n",
     EVIDENCE),
    ("the broker's status answer drops the verdict field",
     "    productionVerdictSource: await slotNamesProductionVerdictSource(deps.slotDirBase, slot),\n",
     "",
     "services/broker/src/app.ts"),
    ("the broker's spec stops requiring the verdict field",
     "notReal, interim, productionVerdictSource]",
     "notReal, interim]",
     "services/broker/openapi.yaml"),
]


def run_suite(root: pathlib.Path) -> bool:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "test_demo_go_live"],
        cwd=root / PROVISION, capture_output=True, text=True,
    )
    return result.returncode == 0


def mirror(root: pathlib.Path) -> None:
    """The files the suite reads, at their repository paths under `root`."""
    shutil.copytree(HERE, root / PROVISION, ignore=shutil.ignore_patterns("__pycache__"))
    for relative in BROKER_FILES:
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(REPO / relative, target)


def main() -> int:
    failures = 0
    for name, old, new, *rest in SABOTAGES:
        relative = rest[0] if rest else GO_LIVE
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            mirror(root)
            target = root / relative
            source = target.read_text(encoding="utf-8")
            if source.count(old) != 1:
                print(f"BROKEN SABOTAGE (pattern found {source.count(old)} times): {name}")
                failures += 1
                continue
            target.write_text(source.replace(old, new), encoding="utf-8")
            red = not run_suite(root)
        print(f"{'RED' if red else 'NOT RED'}: {name}")
        failures += 0 if red else 1
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        mirror(root)
        green = run_suite(root)
    print(f"{'GREEN' if green else 'NOT GREEN'}: unsabotaged suite")
    return 0 if failures == 0 and green else 1


if __name__ == "__main__":
    raise SystemExit(main())
