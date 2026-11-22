# mailProof.ts

## Why the gate asks

Ghost's device verification cannot be configured away. A staff sign-in from a
device Ghost has not seen emails a six-digit code, so a demo whose mail does not
leave is a demo whose owner is locked out with no way back. Working
transactional mail is a precondition for a demo existing, so the arrival page
does not say ready, and does not use up the owner's single-use link, until the
mail path has been proved.

## The proof

One file per slot, `<slot>.mail.json`, in the directory `GATE_MAIL_PROOF_DIR`
names:

```json
{ "slot": "0", "lease": "01J9F4Q7ZC3M8V2K6X0R5T1B9D", "provedAt": 1900000000 }
```

The gate only reads it. Whatever proves a message from that slot's Ghost went
through its spool writes it, beside the lease record. It counts only while its
`lease` is the slot's current lease, so a recycled slot starts unproved and
never inherits its predecessor's proof, and only while it is no older than
`GATE_MAIL_PROOF_MAX_AGE_SECONDS`, so a path that broke after the proof stops
counting.

The record is opened with `O_NOFOLLOW`, like the lease record, and any failure
to read or parse it is "not proved".

## What it does not cover

The gate cannot tell how far the message went. What the writer proves is the
writer's to say; a proof that stops at the spool says nothing about the
collector or mx1.
