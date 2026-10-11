# Scanner service level objective

What is measured about the upload scanner, the query that reads each
quantity, and the target the owner sets. The quantities and queries are
fixed here; **every target value is the owner's to set and is a placeholder
until they do.** Nothing in the platform is judged against a placeholder, and
no alert rule is rendered from one.

The series are the adapter's own export; their names, types and labels are
the contract in `src/metrics.md`. Every query below groups by `tenant`, the
label that export carries.

## Measured quantities

| Quantity | Query | Target | Set by |
| --- | --- | --- | --- |
| Verdict latency, 95th percentile | `1000 * histogram_quantile(0.95, sum by (tenant, le) (rate(scanning_storage_verdict_duration_seconds_bucket[5m])))` (milliseconds) | `SLO_VERDICT_P95_MS` | the owner |
| Verdict error rate | `sum by (tenant) (rate(scanning_storage_verdict_errors_total[1h])) / sum by (tenant) (rate(scanning_storage_verdicts_total[1h]))` | `SLO_ERROR_RATE` | the owner |
| Held-upload age | `max by (tenant) (scanning_storage_held_oldest_age_seconds)` (seconds) | `SLO_HELD_AGE_MAX` | the owner |
| Refusals by reason | `sum by (tenant, reason) (increase(scanning_storage_uploads_refused_total[1d]))` | none: a count, read by reason | not applicable |

The evaluation window for each target is also the owner's. The queries above
use a window only so that they return a number; none of them is a statement
about what window the target is judged over.

Reading them:

- **Latency** includes a request that timed out, which is observed at the
  budget, so a failing channel moves the percentile to the budget and stays
  there. It is not a measure of the channel when it answers.
- **Error rate** counts timeouts and thrown errors against every verdict
  outcome. A tenant with no uploads and no holds has no outcomes and returns
  nothing, which is no data and not a zero.
- **Held age** is 0 when nothing is held, and is dated from the quarantined
  bytes, so it keeps counting across a restart. A hold that stopped retrying
  is counted separately by `scanning_storage_held_stuck`.
- **Refusals** by `unconfigured` is the quantity the owner ruled must be
  known before a tenant reports it. `verdict` and `sealed` are the control
  working and are not a service failure.

## What alerts exist today

Three warnings in `branchLeft/shared-infra`, `hetzner/monitoring/render.ts`,
group `scanner`: an adapter with no verdict source, an upload refused for want
of one, and a verdict channel failing for ten minutes. None reads a target
above. A rule that reads `SLO_VERDICT_P95_MS`, `SLO_ERROR_RATE` or
`SLO_HELD_AGE_MAX` is added in the change that sets it.

None of the three pages a phone. Whether any of them does is a page register
decision, and whether they reach the owner's own mailbox is the
`owner_action` label; both are one reviewed line each.

## What is not measured

- Whether the verdict is **right**. Nothing here observes false negatives.
- The channel's own health beyond the outcomes above. There is no separate
  probe.
- A tenant whose export is off or whose host is not yet read. Absence of a
  series is not a reading.

## Tenant-facing answer for a refused upload

The wording is the owner's. Until they write it, the answer is the
placeholder:

```text
UPLOAD_REFUSED_SCANNER_UNCONFIGURED_ANSWER
```

The answer must cover everything a refusal stops, not only the editor's
upload. At the adapter's current behaviour (`src/verdict-source.md`), with no
verdict source:

| What the tenant meets | What happens |
| --- | --- |
| An editor upload of an image, media or file | Refused with a typed 503 before the bytes are read. |
| An import that brings images with it | Refused the same way. |
| A resized image variant that does not exist yet | Errors; it does not fall back to the original. |
| A bookmark card's thumbnail | Degrades quietly: the card shows without one. |
| An external image Ghost would copy in | Not traced; unverified. |
| Anything already stored, and resized variants that already exist | Keeps being served. |

The rows above were traced against a Ghost source one commit past the pinned
tag, not the pinned image, and are the checklist a reviewer holds the real
answer to. The external image row is the one that is not verified, and how
the admin client shows the 503 is not traced.

The support answers this belongs in are not in this repository; this file
holds the placeholder and its checklist until one is named.
