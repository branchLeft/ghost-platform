# wrapper.ts

## SlotWrapper load

The enumerated `load <path>` verb (`render_slot_sudoers.py`'s
`IMAGE_LOAD_INVOCATION`) — unlike `start`/`stop`/`reset`, the path argument
is not sudoers-enumerable (it names a file, not one of a finite set of
literals), so the sudoers grant fixes it to the single literal path the
image-staging directory's own fixed filename produces; the caller
(`plugins/dockerImageLoader.ts`) is the one that must never pass anything
else. Resolves to the wrapped `docker load`'s own stdout, unlike the other
three verbs, which discard it — nothing else this wrapper runs has output a
caller needs back.

## SlotWrapper detach

The enumerated `<slot> detach` verb: the broker's side of freeze-and-detach
(`POST /freeze`, `app.md#freeze`). The wrapper moves the slot's whole held
set (the slot directory, the content volume with its quarantine, the data
volume) into the held area as one entry, seals, hashes and verifies it, and
prints exactly one receipt line on stdout:

```text
{"entry":"<slot>-<counter>","sha256":"<64 lower-case hex>","bytes":<integer>}
```

That line is the contract the wrapper's `detach` verb must meet. `detach`
resolves only when the process exited 0 and the line parses strictly (no
extra field, no `.partial` entry, a safe-integer byte count); anything else
rejects, and the broker keeps the slot `detaching` with evidence `frozen`.
The broker then also checks that the entry is this slot's. It runs under
`WrapperConfig.detachTimeoutMs` (`BROKER_WRAPPER_DETACH_TIMEOUT_MS`, default
ten minutes), not the shorter bound the other verbs use, because it hashes a
whole tenancy. The verb itself and its sudoers lines are not built here; until
they are, `/freeze` fails safe, every time, at this call.

## createSlotWrapper

Every invocation is `execFile` with an explicit argv array — never a shell
string. `execFile` never spawns a shell to begin with, so there is no
metacharacter for any input to abuse regardless; the discipline this
function actually has to hold is narrower and specific to how sudoers
matches: sudo compares the *space-joined text* of the argv it receives
against each configured command, not argv element by element, as measured
against real `sudo -n`. So `sudo branchleft-slot '0 reset'` — one argv
element holding a space — produces the exact same space-joined text as the
intended `<slot> reset` two-element form and is equally permitted by the
sudoers file, but the wrapper then receives one argument instead of two.
This function is the one place that builds that argv, and it never joins
or interpolates a slot/colour/verb into a single element: `slot`, `colour`
and `verb` each arrive here already validated against their own closed set
(`literals.ts`) and are each pushed as their own argv element, so the
sudoers boundary and this process's own argv agree on where one argument
ends and the next begins.
