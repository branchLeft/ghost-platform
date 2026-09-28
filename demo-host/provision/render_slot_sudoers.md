# render_slot_sudoers.py

## Module overview

Render the demo host's sudoers boundary from the slot table.

Usage:

```text
render_slot_sudoers.py [--out FILE | --install FILE]
```

Prints the generated sudoers file to stdout, or writes it safely to
`--out` (syntax-checked with `visudo -c -f` and written atomically -- see
`write_generated_file`), or writes and installs it with `--install` (the
same safe write, then `chown root:root` -- see `install_generated_file`;
requires root, and is the form host build runs).

The demo host's broker runs as an unprivileged user and needs root for
three things: starting, stopping or resetting a slot's systemd units, one
read-only check the broker cannot otherwise make without a second
privileged read path of its own, and loading a control-plane-pushed image
into the local Docker daemon. The slot verbs' legal invocations are finite
and known before any prospect exists -- fixed slots, two colours, three
privileged verbs plus one read-only verb -- so the boundary can enumerate
every one of them literally rather than accept a pattern. A wildcard in a
sudoers command matches spaces, which turns any pattern-based restriction
into argument injection the moment something reaches it; enumeration has
no pattern to subvert. `load` cannot be enumerated the same way (its
argument names a file, not one of a finite set of literals), so it is
instead granted for exactly one unchanging literal path -- see
`IMAGE_LOAD_INVOCATION` below for why that is still wildcard-free.

This module is the single source of truth for that enumeration: the slot
table below, not forty-nine hand-typed sudoers lines. Extending the slot
count means adding to the table, not editing generated output by hand.

## What sudoers actually binds, and what it does not

sudo compares the space-joined text of the command it is given against
each sudoers command as a literal string -- it does not compare argument
by argument. So `sudo /usr/local/sbin/branchleft-slot '0 reset'`, passed
as a single quoted shell argument, produces the same space-joined text as
the intended two-argument `<slot> reset` invocation and is permitted by
this file, even though the wrapper then receives one argument
(`"0 reset"`) rather than two. No sudoers syntax can pin the split --
sudoers has no notion of argument boundaries to pin, only the string it is
compared against. The wrapper (built separately from this generator) must
therefore reject anything that is not exactly two or three distinct
arguments, each matching its own literal shape -- a known slot name, then
either `reset` alone or a colour in `{a,b}` followed by
`start`/`stop`/`email-batches`. That is the second layer the design
already calls for; this file cannot do that job structurally, so the
wrapper has to.

## IMAGE_LOAD_INVOCATION

`load` is the one verb whose argument is not one of a finite, enumerable
set -- it names a file, not a slot/colour/verb combination -- so it cannot
be enumerated the way `slot_invocations` enumerates the other three. It is
instead granted for exactly one literal path: the fixed filename the
broker's `/image` handler (`services/broker/src/imagePush.ts`,
`IMAGE_STAGING_FILENAME`) always stages a verified push at, inside the one
fixed directory that filename lives in. There is no wildcard here -- a
wildcard would authorise the same argument-injection shape this file
refuses everywhere else, since it matches spaces exactly as freely as any
other character. The broker itself never sends anything else; the second
layer that refuses an invocation this rule was not written for is
`branchleft_slot.parse_invocation`, running as root on the other side of
this grant -- `services/broker/src/plugins/dockerImageLoader.ts`'s own
`realpath` check runs inside the broker, the untrusted principal this
boundary exists to constrain, so it is bug defence for that process, not a
second layer this file can rely on.

## write_generated_file

Writes `content` to `path` the safe way: to a temp file in the same
directory, syntax-checked with `visudo -c -f` before anything can read it,
then renamed into place atomically.

This writes and mode-checks a file; it does not set its owner or make the
path an active sudoers.d entry -- that is `install_generated_file`, which
host build actually runs.

`visudo -c -f` checks syntax only -- it does not check the file's mode. A
file at 0644 parses exactly as one at 0440 does; it is `visudo -c` against
the *whole active configuration* (no `-f`) that refuses a sudoers.d file
with the wrong permissions, and only once it is already in place. So the
0440 this function sets is its own guarantee, not something a syntax check
would have caught for it.

On any failure the temp file is removed and `path` is left untouched -- a
partial or invalid write never reaches the target path.
