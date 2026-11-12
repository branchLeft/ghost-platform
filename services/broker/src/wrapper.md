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

## stderr on one line

A failed run rejects with a `WrapperError`. Its `message` is the head line only,
`slot wrapper failed: ` and the first line of Node's own `err.message` (the
`Command failed: ...` line), cut at the first CR, LF, U+0085, U+2028 or U+2029
and with any other control character escaped. That message can reach an HTTP
body (the colour swap's 503 carries it), so it never holds the child's stderr.

The stderr stays on `WrapperError.stderr`. `WrapperError.logMessage` is the
message, then ` stderr: ` and the stderr from `stderrOneLine`, and
`errorLogText(err)` is what the broker's log lines print for a caught error. A
grep of the log finds the wrapper's reason on the same line as the failure.

`stderrOneLine` trims the stderr, then writes every C0 control character, DEL,
U+0085, U+2028 and U+2029 as a visible escape: `\r`, `\n` and `\t` by name,
the rest as `\uXXXX`.
