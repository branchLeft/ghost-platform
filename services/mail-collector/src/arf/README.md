# ARF complaint reader

Reads one RFC 5965 abuse report (the format mailbox providers use for
feedback-loop complaints) into the one fact the spool needs: a recipient
complained about a message this collector submitted. `arfReader.ts` is pure (no
clock, no I/O, no logging); `../outcomeRunner.ts` is the only caller.

## What a report becomes

A `ComplaintRecord`: the recipient, the spool the message was drained from (the
tenant or demo stream), the message id and claim generation, the configured
source name it authenticated as, and when we received it. The record is mapped to
the existing outcome path as `{ id, drainCount, outcome: 'complained' }` on
`POST /drain/outcomes`, the same shape the Sweego poller uses. The report to the
spool carries no address: the spool resolves who to suppress from the id and
generation, so a wrong address in a report can never suppress a different
person. The recipient in the record is read, cross-checked and then used only for
the checks below.

## Fail closed

Every doubt returns a named rejection and no record. The runner retires a
rejected message to `processed/` (never deletes it) and logs the reason only.

| Reason | Means |
| --- | --- |
| `not_arf` | Does not say `report-type=feedback-report` in its first 16 KiB. Not judged; a DSN stays a DSN. |
| `oversized` | Over 256 KiB (counted in bytes). |
| `malformed` | Broken or ambiguous MIME or fields: a NUL or lone CR, a header line that is not `name: value` (or has a space before the colon), a missing, repeated or illegal boundary, no closing boundary, more than 6 parts or 200 headers, an encoded (base64 or quoted-printable) report or original part, other than exactly one report part and one quoted original, a second field group, a report part over 16 KiB, `Version` other than 1, a missing `Feedback-Type` or `User-Agent`, a repeated `Feedback-Type`, `Original-Rcpt-To` or `Arrival-Date`, an `Original-Rcpt-To` that is not one plain address, two `Message-ID` or two `To` headers in the original. |
| `unauthenticated` | Not proven to come from a configured source (below). |
| `feedback_type_not_abuse` | `not-spam` (a reversal), `fraud`, `virus`, `other`. Only `abuse` complains. |
| `no_message_id` / `not_ours` | The quoted original has no `Message-ID`, or one this collector did not mint (`outcomeId.ts`). |
| `no_recipient` / `recipient_mismatch` | No recipient anywhere, or `Original-Rcpt-To` disagrees with the quoted `To`, or the quoted `To` is a list, a group or unreadable. |

Only the header block of the quoted original is read, never its body, so a
report or boundary quoted inside the body cannot become the report. Only the
top-level parts count, so a nested multipart in the human-readable part cannot
add a second report. The sender's `Arrival-Date` is informational (dropped unless
it is a sane date); the record's timestamp is the caller's receive time.

## Who may complain

The reader is built from `{ trustedAuthservId, sources }` and refuses an empty or
malformed configuration at construction. A report is accepted only when the one
`Authentication-Results` header carrying `trustedAuthservId` (the id our own
receiving MTA stamps) shows `dkim=pass` for a signing domain that is, or is under,
a configured source's domain, and the visible `From` is that domain or under it.
Comments in that header are stripped before it is read; a second header carrying
our id, an unbalanced comment, a failed or neutral result, a look-alike domain, or
an unaligned `From` all reject.

## Turning it on

Off unless `complaintReader` is given to `createOutcomeRunner`; with it absent the
runner behaves exactly as before. There is no environment wiring yet. Give it
only once the spool accepts a `complained` outcome, because a spool that cannot
parse one rejects the whole batch (the same reason the Sweego poller has
`reportComplaints`). Registering with each provider's feedback loop, and the
mailbox transport that puts the reports in the directory the runner reads, are
owner steps and not part of this module.

## Unproven until a real report is seen

The fixtures in `../../test/fixtures/arf/` are synthetic, built to the RFC.

- That our receiving MTA stamps `Authentication-Results` with a known id on mail
  to the return-path mailbox, and removes any such header already on inbound mail
  (RFC 8601 section 5). Without that the authentication above is not a control.
- Whether each provider's real report keeps the recipient and the original
  `Message-ID` rather than redacting them. A redacted report is rejected
  (`no_recipient` or `not_ours`) and so does not suppress anyone.
- Which signing domains each provider uses for its reports: the configured
  `dkimDomains` are the owner's to fill from a real report.
- That a report's quoted `To` is not rewritten by the provider; if it is, the
  report is rejected as `recipient_mismatch`.
