# branchleft_slot.py

## Module overview

The forced-command wrapper `render_slot_sudoers.py` enumerates.

Installed at `/usr/local/sbin/branchleft-slot`, root-owned and executable,
and invoked only through the sudoers rules that file generates: `broker
ALL=(root) NOPASSWD: /usr/local/sbin/branchleft-slot <invocation>`, one
literal line per enumerated invocation.

## Why this file exists, given the sudoers file already enumerates every legal invocation

Measured against real `sudo -n`: sudo compares the *space-joined text* of
the argv it receives against each configured command as a literal string,
not argv element by element. So `sudo branchleft-slot '0 reset'` -- one
shell-quoted argument holding a space -- produces the same space-joined
text as the intended two-argument `<slot> reset` invocation and is equally
permitted by the sudoers file, but this process then receives ONE argument
(`"0 reset"`), not two. The sudoers file and this wrapper are the boundary
*together*: sudoers can only ever prove an invocation is on the list once
its arguments are already split into how many the wrapper expects, and
splitting is exactly the step sudo does not do. So `parse_invocation`
checks argv's own length first and then each element against its own
closed set -- it is never given cause to join or re-split anything, and it
must never gain one: joining argv into a string and matching a pattern
against it is the exact defect this module exists to not have.

## What this process does

Per LLD-2 §02: validate that argv is exactly the enumerated shape, take an
exclusive lock on the named slot so two reconciles cannot interleave, then
start or stop the one systemd unit that shape names -- or for `reset`,
stop both of a slot's colour units and wipe the slot's own state. For
every slot/colour/reset invocation it never touches the Docker socket
(systemctl is the only privileged primitive it uses there -- a docker
command is root with no gradation, which is the exact erosion enumeration
exists to avoid), never accepts a path as an argument, never writes
`/etc/branchleft/<slot>-<colour>.env` (the broker writes that,
unprivileged, before ever asking for a start), and never reads or touches
anything outside the one slot its argv names.

## The email-batches verb

`email-batches` is read-only rather than privileged: it takes no lock and
never calls `systemctl`, only a single fixed `COUNT` query
(`count_submitting_email_batches`) against the named slot's own SQLite
file, printing the bare count to stdout. Enumerated the same way as
`start`/`stop` (see `READ_VERBS`) because sudoers' own boundary has no
notion of "read-only" -- only "on the list" -- so it gets the identical
argv-shape scrutiny `parse_invocation` already gives every other verb.

## The load verb

A fourth verb so the broker can hand a control-plane-pushed image to the
local Docker daemon without ever holding the socket itself. It is a
narrow exception, not a hole in the boundary above, for three reasons
taken together: the argument is not a caller-chosen path but one single
literal string (`IMAGE_LOAD_PATH`, matching
`render_slot_sudoers.IMAGE_LOAD_INVOCATION` exactly) -- anything else is
refused by `parse_invocation` before this process does anything at all;
the sudoers grant itself only ever offers this one process that one
literal invocation to begin with; and what this process does with it does
not trust the path's name a second time -- `RealSlotOps.load_image` opens
that exact path with `O_NOFOLLOW` and `O_NONBLOCK` (a symlink at the leaf
is refused by the kernel rather than followed; a FIFO returns at once
rather than blocking this process, which runs as root, until some writer
chooses to appear), `fstat`s the open descriptor (never a second `stat()`
on the path, which would reopen the TOCTOU window `O_NOFOLLOW` exists to
close) to require a regular file, under `IMAGE_LOAD_MAX_BYTES`, owned by
the broker account, and only then streams that already-open descriptor
into `docker load`'s stdin, under `IMAGE_LOAD_TIMEOUT_SECONDS`.

## What load pins, precisely

`IMAGE_STAGING_DIR` is provisioned broker-owned (host build, and
`services/broker/src/server.ts`'s own `mkdir`), so nothing here rules out
the broker renaming that directory and putting a symlink where it was, or
simply writing whatever bytes it likes at the literal path in the first
place -- `O_NOFOLLOW` refuses a symlink at the exact leaf, not a swapped
parent. The check that actually holds the boundary is `st_uid == broker`:
a root-owned file is never reachable this way no matter what the broker
does to the directory, and a broker-owned file is exactly the power the
broker already had before `load` existed. "Loads nothing else" means
precisely that -- never a file the broker does not itself own -- not that
the literal path names one unchanging file on disk.

## _data_directory

The one, slot-derived path to the colour pair's shared SQLite data volume
-- never a caller-supplied path. Mirrors `render-core`'s `demoDataMount`
(`render-core/src/render.ts`): the volume is named `ghost-demo-<uid>-data`,
and `uid` is `UID_BASE + int(slot)` -- the one field
`services/broker/src/app.ts`'s `handleReconcile` enforces must equal the
slot's own allocation before any render happens, so it is safe to
re-derive here from the slot literal alone.

Colour-blind on purpose: `render-core/src/compose.ts`'s `composeDocument`
mounts this same volume into *both* `ghost-a` and `ghost-b` -- one shared
SQLite file per slot, not one per colour -- so a colour argument changes
nothing about which file this opens.

## _open_slot_db_no_follow

Opens `path` read-only, refusing anything but a plain regular file owned
by `expected_uid` -- and never the file a second lookup might resolve to.

**What this is, and what it is not.** The volume this path lives in is
written by the tenant's own Ghost container (`render-core/src/compose.ts`
runs it as `user: "<uid>:<uid>"`), so the *name* `email-batches` opens is
chosen by code the tenant controls. This check screens the *first* open,
and only the first: `O_NOFOLLOW` refuses a symlink outright here;
`O_NONBLOCK` means opening a FIFO or several device types returns
immediately rather than blocking (a documented no-op for a regular file,
so it costs a correct caller nothing); `fstat` on the already-open
descriptor -- never a second `stat()` on the name, which a rename could
race -- proves what this call actually opened is a regular file owned by
exactly `expected_uid`.

**It does not bind sqlite to this exact descriptor.**
`_count_submitting_from_fd` hands sqlite this fd's own `/dev/fd/<n>` path
rather than `path` again, which looks like it should be equivalent to
querying the descriptor directly -- it is not: sqlite's own unix VFS
canonicalises that path back to a name (`readlink`s through it) and
reopens *that*, so a rename raced in between this check and sqlite's own
open can still swap what actually gets read. This function is a
first-open pre-screen, never sqlite's binding guarantee. **The privilege
drop is what actually matters here** (`_read_submitting_count_as_uid`'s
own doc comment): by the time this runs, the caller already has no rights
beyond the slot's own uid, so the *worst* a won rename race achieves is a
wrong count for the tenant's own already-owned data -- never a read of
anything owned by another slot or by root. A FIFO or device swapped in
after this check is still caught: sqlite's own open has no `O_NONBLOCK` of
its own, so it can block, but `_read_submitting_count_as_uid`'s hard
wall-clock timeout kills a wedged child regardless, fail-closed.

Returns an open fd the caller owns and must close.

## _count_submitting_from_fd

Runs `_SUBMITTING_COUNT_QUERY` via `fd`'s own `/dev/fd/<n>` path --
**not a guarantee that sqlite reads exactly the descriptor
`_open_slot_db_no_follow` already validated.** `/dev/fd/<n>` looks like a
bound alias for the open file, but sqlite's own unix VFS canonicalises
every path it is given, `/dev/fd/<n>` included: it `readlink`s through to
the underlying name and reopens *that*, not the file descriptor number. A
rename raced in between the fstat check and this call can therefore still
change what sqlite actually reads. See `_open_slot_db_no_follow` above for
why this is a first-open pre-screen rather than sqlite's own binding
guarantee, and why the privilege drop -- not this function -- is what
actually keeps the read inside the slot's own rights.

## _read_submitting_count

The core, privilege-agnostic check: select the one candidate path by name,
open it refusing anything but a regular file owned by `expected_uid`
(`_open_slot_db_no_follow`'s own first-open pre-screen), then run the one
fixed count query (`_count_submitting_from_fd`, whose own section above
covers what that pre-screen does and does not bind). Safe to call directly
when the caller is already running as `expected_uid` -- every test in this
module does, since a test process is never root -- or from inside the
privilege-dropped child `_read_submitting_count_as_uid` forks, which is
what actually keeps a race here confined to the slot's own rights.

## _read_submitting_count_as_uid

Runs `_read_submitting_count` in a forked child that has dropped to
`uid`/`gid` *before* touching anything the tenant's container wrote -- so
root itself never opens a path the tenant chose; only a process with
exactly the tenant's own rights does. **This drop is the binding
control**, not `_open_slot_db_no_follow`'s own O_NOFOLLOW/fstat/owner
checks (see that section above for why sqlite's later reopen-by-name can
still race past them): once privilege is dropped, the worst any such race
can do is hand the tenant a wrong count for its own already-owned data,
never a read of another slot's or root's. The still-privileged parent
never drops anything itself: it enforces `_READ_TIMEOUT_SECONDS` as a hard
wall-clock bound, killing the child outright on a timeout rather than
trusting `O_NONBLOCK` alone to rule out every way this could wedge, and it
never trusts the child's own claim of success without checking the child
actually reports having run as `uid` -- a child that could not drop
privilege (or one that had that call silently disabled) reports its
*real* uid instead, which the parent catches here rather than returning a
count read at the wrong privilege.

## parse_invocation

The one function that decides whether argv is legal.

Checks length first, then membership of each element in its own closed
set -- `argv[i] in ALLOWED_SET`, always. Nothing here calls `.split()`,
`.join()`, `" ".join()` or any string formatting on argv itself before
comparing it; the only formatting in this module happens *after*
validation, when building the unit name or path from an already-checked
slot/colour. That absence is the property under test: a caller that
reduces argv to a string at any point before this function returns
reproduces sudo's own defect on the second layer, in the one place that
exists to not have it.

`load`'s argument is checked by the same discipline as everything else
here: membership in a closed set, just one of size one
(`{IMAGE_LOAD_PATH}`) rather than seven or two. A single shell-quoted
argument `"load /var/.../image.tar"` -- sudo's own `'0 reset'` defect,
reproduced for this verb -- has `len(argv) == 1` and falls straight
through to the final `raise`, exactly like a bare `"0 reset"` does; there
is no separate branch for it to slip past.

## RealSlotOps.load_image

Opens `path` (always `IMAGE_LOAD_PATH` -- `parse_invocation` accepts no
other value) with `O_NOFOLLOW` and `O_NONBLOCK`: a symlink planted at that
exact leaf is refused by the kernel's own open(2) rather than followed,
and a FIFO planted there returns at once instead of blocking this
process -- which runs as root -- until some writer chooses to appear (a
compromised broker can `mkfifo` at this path exactly as easily as it can
write a regular file). `fstat`s the resulting descriptor -- never a second
`os.stat(path)`, which would re-resolve the name and reopen exactly the
race `O_NOFOLLOW` closes -- and requires a regular file, no larger than
`IMAGE_LOAD_MAX_BYTES`, owned by the broker account. `O_NONBLOCK` is
cleared again before `docker load` ever reads the descriptor (a regular
file's reads are never actually blocking regardless of the flag, but
clearing it leaves nothing for a future reader of this code to wonder
about), and the load itself runs under `IMAGE_LOAD_TIMEOUT_SECONDS` --
`subprocess.run` kills the child on expiry rather than leaving a hung
`docker load` behind. Only the verified, already-open descriptor is ever
handed to `docker load`, on its stdin, so docker itself never resolves
`path` a second time either.
