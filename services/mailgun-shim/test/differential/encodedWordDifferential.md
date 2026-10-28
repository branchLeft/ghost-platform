# encodedWordDifferential

Measures whether any sender the gate binds is read, by a recipient's mail
software, as a domain other than the tenant's or as no domain. It checks the
sender gate's rule on encoded-word text (`src/senderAuthorization.md#encoded-words`)
against the readers themselves, so the rule is held to what readers do and not
to what the gate expects.

It is not part of `npm run test:unit`: a full run takes several minutes. The
unit tests carry the pinned rows; this carries the breadth.

## What it does

1. Regenerates a corpus from a seed (no corpus is committed). Each value
   places encoded-word text, in several charsets, in Q and B encodings and in
   both cases, in an address token, a group name, a quoted string, a comment,
   a display name and a folded line, writes the delimiters as quoted-pairs
   inside a quoted local part, group name or name (`"\=\?utf-8\?q\?x\?\="`),
   and adds control values with none.
2. Submits every value to the real HTTP router and the real SMTP front door
   (as a header From, and, for values that can be one, as the envelope sender
   of a message with no header From), against a real store.
3. For each value the gate accepted, takes the queued sender and composes a
   message with nodemailer the way the mail collector does.
4. Reads the composed From header with `mailparser` and with three Python
   readers (`encodedWordReader.py`, standard library only): the default
   policy, `getaddresses` and `parseaddr`.
5. Counts a disagreement when a reader finds a domain other than the tenant's
   or finds none.

## Running it

```text
npm run build
node test/differential/encodedWordDifferential.mjs [--seed N] [--size N] [--concurrency N] [--json] [--control] [--show N]
```

Needs `python3` on the path; without it the script says so and exits cleanly.

- `--seed`, `--size`: the corpus (defaults: seed 1, 6000 values).
- `--control`: expects disagreement. Run it against a build whose refusal is
  removed, so a zero in the real run is not a harness that reads nothing. It
  exits 0 only when it finds some.
- `--show N`: print the first N disagreeing values to stderr, for diagnosis.

The output names the corpus size, a hash of the generator and the reader, the
reader versions, and, for each route, the values attempted and accepted and
the disagreements per reader and per position.
