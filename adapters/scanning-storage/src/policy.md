# policy.js

## What a match does

`SafetyPolicy.decide(verdict)` answers `allow`, `hold` or `refuse`; a refusal
is any match. `tierOf(verdict)` (also `SafetyPolicy.tier`) says which kind of
match it was, and the tier is what the rest of the adapter acts on.

| Verdict | Tier | What happens automatically |
| --- | --- | --- |
| `csam` with `matchType` exactly `exact` | two | Withhold, seal under the digest, start the reporting clock. The only irreversible tier. |
| `test` | two | Behaves as a match through the whole path, which is how the control is proven without anyone holding anything. |
| `csam` with any other `matchType` (`near`, none, a different case) | one | Withhold and freeze. Reversible; nobody has decided anything yet. |
| `harmful-abusive-material`, any `matchType` | one | The same. Broader than the illegal-material list and not a criminal determination. |
| any other classification this code does not know | one | The same: every doubt rounds down. |
| `no-known-match`, `unavailable`, no verdict | none | Not a match. |

Nothing is sent to a third party at either tier, and no human views the
material. A tier-one freeze is the same on a demo and on a tenant. The one
thing that differs by estate is a tier-two match on a demo, which kills the
slot; that is the control plane's (`services/broker/src/matchAction.md`), and
the adapter never dials out. `matchAction.test.ts` holds the two `tierOf`
functions to one table.

## The record

A refusal's record (`<digest>.refused.json`) now names the tier and what was
done: `tier`, `action` (`seal` or `freeze`), and `sealedAt` or `frozenAt`.
`sealedAt` is when the reporting clock started; the alarm on it is another
story. A tier-one freeze is replaced by a seal when a later verdict says
`exact`, with `sealedAt` taken then. A seal is never replaced by anything. A
record an older release wrote, with no tier, reads as the tier its verdict
falls in; one that cannot be read at all reads as tier two, so nothing lifts it.

## Every copy

One upload is several objects: the processed image, the untouched `_o`
original, and any responsive derivative. Their bytes differ, so a verdict on
one names none of the others. Every object the adapter writes is therefore
entered in a ledger (`<hash>.copies.json` in the quarantine directory, one per
family, the family being the path with the `size/<w>/` and `format/<f>/`
directories and the `_o` taken off). When a match is made, whether at an
upload, when a held upload resolves, or by `applyVerdict(digest, verdict)` for
bytes already stored, the adapter:

1. marks the family frozen, so `exists()`, `read()` and `serve()` answer
   absent or 404 for every path in it, and a new write into it (a derivative
   generated now) is refused;
2. reads each stored copy back and keeps it under its own digest, at the same
   tier, in the quarantine directory;
3. removes it from the served location.

A copy that cannot be read back is not removed, and one the backend refuses to
remove stays where it is; both are logged (`FREEZE_INCOMPLETE`) and counted
(`scanning_storage_freeze_incomplete_total`). The storage gateway in front of
a tenant bucket has no delete, so on a bucket the adapter can answer absent
for the family but cannot take the object out of the bucket, and that counter
is how it says so.

A tier-one freeze is undone from the digest alone with `liftFreeze(digest)`:
every copy is written back from quarantine and the records go. It answers
`sealed` and changes nothing when any record in the family is tier two. A
frozen family is not unfrozen by anything else; a later upload to a frozen
path is refused until it is lifted.

Video and audio on a tier that accepts them are stored unchecked and are not
in the ledger: no verdict will ever name them (`tier-policy.md`).
