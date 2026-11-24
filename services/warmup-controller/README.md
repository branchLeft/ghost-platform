# warmup-controller

The decision code that moves the newsletter lane's second sending address (IP2) up its seven warm-up stages. It reads one day's evidence and says advance, hold, wait, step down, stop or resume. It sends nothing: no module imports an SMTP client, a socket or a subprocess, and `test_stages.py` fails if one does.

Python because the controller is a timer-run script on the mail host, not a service, and the workspace prefers typed Python (mypy strict, ruff) over shell for such work. The thin shell that fetches evidence, and the timer that runs it, are separate pieces.

## Shape

| File | What it holds |
|---|---|
| `warmup_controller/stages.py` | The stage table. `test_stages.py` pins it to `services/mail-collector/src/ip2Lane.ts`. |
| `warmup_controller/model.py` | Evidence in, state, decision out. Frozen data. |
| `warmup_controller/rules.py` | Every gate value and every check, named so a sabotage run can break one alone. |
| `warmup_controller/decide.py` | `decide(evidence, state, clock, cards)`. Pure. |
| `warmup_controller/store.py` | The two state files and the ledger. |
| `warmup_controller/runner.py` | `run_once`: decide, append the ledger row, then write both state files. |

## The files

- **Collector file** (`published_state`): `stage`, `held`, `destinationHolds`, as the collector's `parseIp2State` reads them, plus `effectiveCap`, the stage cap held down to proven volume. The collector ignores keys it does not know.
- **Controller state** (`controller_state`): the controller's own memory (when the stage began, the stop and its reasons, the last step down). The collector never reads it. A file that is there and cannot be read exactly stops the run before any write.
- **Ledger** (`ledger`): JSON lines, appended only. One `daily` row per UTC day, and an `event` row for a step down, stop or resume on a day that already has its row. A second `daily` row for a day, or a ledger with a half-written or unreadable line, is refused and nothing is written. The ledger is written first: a run that cannot record why changes no state.

## What decides

Evidence for a run at time T covers the complete UTC days before T's day. A stopped lane first looks for a resume. Otherwise, in order:

1. **Stop** (`held: true`): IP2 on a blocklist; Gmail spam rate 0.30 percent or over; 5 or more 5.7.x rejections on the newest day; a seed in spam. Acts on whatever evidence it has, however old.
2. **Step down**: a receiver's second 4.7.28, 451 4.7.650 or Yahoo TS deferral within 7 days drops one stage. Only deferrals after the last step down count, so the same two never step down twice.
3. **Wait**: the newest day had no real mail. Nothing moves; the ledger row says `wait`.
4. **Advance** when every gate passes, once a UTC day; otherwise **hold**, with the failing gates named. A hold on a bounce, spam-rate, deferral, seed or DMARC gate restarts the stage's 7-day window. A hold for too few days, too little real mail, a missing feed or no data does not.

Advance gates: 7 days at the stage; hard bounces under 2 percent of the week's real mail; Gmail spam rate under 0.10 percent (Postmaster data required from stage 4); no deferral in 72 hours; not blocklisted; seed placement recorded as inbox; DMARC alignment 100 percent; real mail at half the stage cap on at least 4 of the last 7 days; every feed under 48 hours old and present; not at stage 7; not already advanced today.

Effective cap: `min(stage cap, max(50, 1.5 x the highest clean real day in the last 14))`.

Resume: the owner's card, which names the stop it answers, or, for a stop whose only reason was a blocklist listing, 24 hours after the listing cleared. Either way the lane returns one stage lower, at least stage 1, with a fresh window. Raising stage 7's ceiling is never a code path.

## Real mail only

Only `real_sent` is counted anywhere: the evidence floor, the bounce rate, the clean-day test, the proven-volume ceiling. `seed_sent` is carried into the ledger as `seedSentNotCounted` so a reader can see it was seen and ignored. A day with no real mail is a `wait`, and stage 1's floor of 25 real messages a day means a handful of real readers holds the lane.

Readings that go beyond the design text, each one constant or function in `rules.py`:

- The evidence floor needs real mail on 4 days; an empty queue does not stand in for a day, or a day with no mail would pass it.
- "A cluster of 5.7.x rejections" is 5 on the newest day.
- A resume after any stop returns one stage lower; the design fixes this only for a cleared blocklist.
- `destinationHolds` is carried through unchanged; nothing sets it yet.

## Proof

```sh
cd services/warmup-controller
python3 -m unittest discover -s . -p 'test_*.py'
python3 -m mypy .
python3 sabotage.py
```

`sabotage.py` breaks one rule at a time in the real code and shows the guarding tests go red, then shows them green unbroken: advances on seed mail, advances on stale evidence, cap above proven volume, resumes without the card, resumes a cleared blocklist at once. `test_sabotage.py` runs the same proof on every test run.
