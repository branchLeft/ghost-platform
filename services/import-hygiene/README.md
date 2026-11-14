# import-hygiene

Import hygiene rules for a member list: a consent record, a free list check,
a first-send plan and a hard-bounce stop. It is a library and a CLI. It is not
wired into the member importer or the portal; that wiring is a later step.

## Rules

- **Consent record** (`src/consentRecord.ts`): where and when the list
  consented. An absent or invalid record sets `needsReconfirmation`; it never
  passes silently. `where` is free text of at most 200 characters; `when` is an
  ISO date that is not in the future.
- **List check** (`src/checkList.ts`): drops an address that fails syntax, one
  whose domain is on the tenant suppression list (case-insensitive, checked
  before any DNS query), and one whose domain has no MX and no A or AAAA record.
  A lookup that times out or fails keeps the address and counts it `unknown`.
  The DNS resolver is injected (`src/dnsLookup.ts`). An MX-less domain with an
  A or AAAA record is deliverable (implicit MX).
- **First-send plan** (`src/firstSendPlan.ts`): each batch holds at most
  `floor(share x dayCap)` members, with `share` defaulting to 0.25. When
  engagement data is given, engaged members come first; unscored members follow
  in their original order.
- **Hard-bounce stop** (`src/hardBounceStop.ts`): a first batch stops the import
  when its hard bounces are above 5 percent of the batch. The comparison is in
  integers, so exactly 5.0 percent continues and 5.1 percent stops. A batch of
  zero continues.

## CLI

```
import-hygiene check --in LIST.csv --suppression S.csv --consent C.json --out CLEAN.csv --report REPORT.json
```

- `LIST.csv` and `S.csv` must each have a header with an `email` column. A
  missing suppression file stops the run; it never passes every address.
- `C.json` is `{"where": "...", "when": "YYYY-MM-DD"}`. A missing file is an
  absent record.
- `CLEAN.csv` keeps the kept rows with all their original columns.
- `REPORT.json` holds counts, reasons and row numbers (1-based, not counting
  the header). It holds no address and no consent free text.

Printed output is a counts-only summary line. Error messages name a file or a
column, never a cell value. Addresses are personal data: nothing in this
package logs or reports one, and a test scans every output string of a run
for each fixture address.

## Development

Install with scripts ignored, so no repo hook is installed from a worktree:

```
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run test:unit
pnpm run build
```

Tests use fabricated addresses at reserved domains (`example.com`,
`example.org`, `.test`) and a fake DNS resolver. No test contacts the network.
