# runbook-literal-placeholders.test.js

## Placeholder and literal checks

A committed runbook must not carry either half of the same defect: an
unsubstituted placeholder in a copy-pasteable command, or a concrete
operational value (a fixed host's address) committed as a literal. Both
break the runbook the same way for a reader who pastes the command as
written -- one form cannot resolve at all, the other silently drifts once
the value it copied stops being current. The fix in both directions is
threading the value through a shell variable a lookup command populates,
never a hardcoded string and never an unresolved placeholder.

Two checks, not three, over the same fenced blocks:

- `addressPlaceholders` matches any unresolved, address-shaped placeholder
  token anywhere in a command fence -- an assignment's whole value,
  `export`ed, `local`, quoted, split across a line continuation, or an
  argument inside a larger command. Hostname and position are not the
  property that makes one of these wrong: it reads as an address (its
  trailing word is ip/ipv4/address/addr) and nothing has substituted it,
  independent of which host it names, whether it names one at all, or
  where in the line it sits. A host-name scope and an assignment-shaped
  scope were both tried and each left a gap the other didn't cover.
- `fixedHostLiterals` is a genuinely different property and stays
  separate: it matches only the bare, exact literal value of a specific,
  known fixed host, never a `/32` or a CIDR, and never a threaded
  `$VARIABLE` reference.

Deliberately narrower than "no `<...>` anywhere in a fenced block" or "no
IPv4-shaped token anywhere in a fenced block":

- Only `bash` and `sql` fences count as command blocks in this repo's
  runbooks -- `text`/`yaml`/`json` fences here hold illustrative sample
  output, never something pasted and run.
- The address word must be *trailing*, not merely present, so a
  per-invocation credential id such as `<db1 backup key id>` is left
  alone: it is not an address, and this scanner does not track resource
  ids at all -- a resource looked up fresh by id (rather than hardcoded)
  is a different, already-correct pattern this scanner has no opinion on.
- A token that legitimately varies per invocation (`<slug>`, `<tenant>`,
  `<digest>`, `<run-id>`, `<host>`) is not address-shaped and never
  matches, whether it is an assignment's whole value or an argument
  inside a larger command.

## Teardown ordering check

The Teardown section must not delete the directory that holds a tenant's
Compose file before anything stops the containers that file describes --
the unit that starts them carries no ExecStop, so nothing else in the
section can stop them once that file is gone. This check pins the fix at
the text level: a label-filtered `docker stop` (never a `docker compose
... down`, which re-parses the Compose file and fails on every real
tenant's mandatory `${VAR:?...}` secrets -- see the comment beside step 2
in the runbook itself) has to appear, and it has to appear before the
line that removes the tenant's directory and before the line that
removes its named volumes, wherever those sit across the section's
fenced blocks.
