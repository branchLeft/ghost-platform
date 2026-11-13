# test_branchleft_slot.py

## CountSubmittingEmailBatchesTests

`count_submitting_email_batches` takes no fork here -- a test process is
never root (`os.getuid() != 0`), so every call in this class exercises
`_read_submitting_count` directly, at whatever uid the test itself runs
as. `UID_BASE` is patched to that real uid (always slot "0", so
`expected_uid = UID_BASE + 0` lands exactly on it) for every test that
expects a real file it creates to be *accepted* -- the file is genuinely
owned by the test process, so the owner check is exercised for real, not
bypassed. Left at its production default (almost certainly not this
process's own uid) wherever a test does not patch it, which is exactly
what the "wrong owner" test relies on.

## test_a_real_self_drop_succeeds_end_to_end_through_the_pipe

`setuid(getuid())` is a no-op POSIX permits any unprivileged process to
perform on itself -- the one way to exercise a *successful* privilege
drop's setuid call for real without being root. `setgroups([])` always
requires real privilege (there is no "unless it's already my groups"
exception in POSIX); this platform's setgid also refuses an unprivileged
caller even at its own current gid (stricter than Linux's own permitted
self-target case) -- both are mocked away here, since neither is testable
from an unprivileged process on this platform either way, so that setuid
-- the call this test actually means to prove -- runs for real. No
`UID_BASE` patch needed: `_read_submitting_count_as_uid` takes `uid`
directly, and `_data_directory` (used both to create the fixture here and
inside the call under test) derives its own path from the same, untouched
default `UID_BASE` either way.

## test_a_real_setuid_to_an_unreachable_target_is_refused_before_any_read

`setgroups`/`setgid` are mocked away for the same platform reason as the
self-drop success test (both fail unconditionally here, masking whatever
setuid itself would do) -- setuid is left real. A target uid this process
cannot reach must fail via a real `PermissionError` raised *by setuid
itself*, distinguishable from the "silently no-op'd" test above (which
mocks setuid away on purpose): removing the real `os.setuid(uid)` call
would let the child fall through to the mocked, always-succeeding
`_read_submitting_count` and report success at its own (unchanged) uid --
caught only by the parent's separate uid mismatch message, not this one,
so the two assertions together are what make the setuid call's own
presence load-bearing.

## test_refuses_a_fifo_at_the_exact_path_without_blocking

A compromised broker can `mkfifo` at the fixed path exactly as easily as
it can write a regular file -- without `O_NONBLOCK`, root's own `open(2)`
blocks until a writer appears, which never happens here. `signal.alarm`
guards the test itself: a regression fails this test loudly and fast
rather than hanging the whole suite (or a real host's root process)
waiting on nothing.

`_AlarmFired` is deliberately not an `OSError` subclass -- Python's
builtin `TimeoutError` *is* one, and `load_image`'s own `except OSError`
would otherwise catch a signal-interrupted `open()` call and re-wrap it
as `RefusedImage`, making a genuine hang (caught only by this alarm) look
identical to a clean, immediate refusal. That is exactly the false green
this test exists to not produce.

## VolumeEmptyingResetTests

Drives `main` through `RealSlotOps` against a scratch tree: `SLOT_DIR`,
`ETC_DIR`, `LOCK_DIR` and `DOCKER_VOLUME_ROOT` are all patched into one
temporary directory, and `subprocess.run` is mocked so the only thing a reset
could shell out to is recorded. Slot 1's data volume is `ghost-demo-30002-data`
and its content volume is named by the slot's `compose.yml`. Each volume is
seeded with nested markers and with symlinks to a file and a directory outside
the tree, and a fake adapters volume holds a marker. The class asserts both
`_data` directories end empty but still exist, the adapters marker and every
outside target survive, and every refusal (a symlinked volume directory, a
symlinked or regular-file `_data`, an ambiguous `compose.yml`) exits nonzero
with the slot directory and the other volume left as they were. The swap test
replaces a directory with a symlink between the listing and the open, which is
the race `O_NOFOLLOW` exists for. The same assertions run in CI, so a change
that drops the emptying call, the no-follow open or the adapters guard turns
this class red.

## RealSlotOpsLoadImageTests

None of this needs root to prove the checks exist and run in the right
order. `pwd.getpwnam` is patched to name the test process's own uid as "the
broker account", so the owner check runs for real. `chown` was rejected: it
needs root, and it would only prove that some check runs somewhere, not that
it runs against the right descriptor before docker is ever reached.
`.github/workflows/demo-host-sudoers-ci.yml` re-proves the same shapes
against a real broker account and real ownership; this class is the fast,
hermetic form.

## test_a_mount_point_inside_the_volume_is_refused_and_not_crossed

The walk checks each subdirectory's `st_dev` against its volume's. A mount
point inside the volume reports another device, so the reset must refuse
and leave its contents alone. The test fakes `st_dev + 1` for that one
descriptor, since a real mount needs root. `sabotage_branchleft_slot.py`
disables the check in a scratch copy: the suite must go red, then green.

## UnitIsStoppedTests

`RealSlotOps.unit_is_stopped` is the whole of the reset's tolerance ruling: a
colour unit counts as stopped only when it is not loaded (`LoadState=not-found`)
or already inactive (`ActiveState=inactive`). `subprocess.run` is patched, so
each test feeds it one `systemctl show` output. Not-found alone and inactive
alone each get a test, so dropping either branch turns one red. Every other
active state, every other load state, a property that does not come back, and
output with no properties at all must read as not stopped. A `systemctl show`
that fails must raise: the double raises only when the call asked for
`check=True`, so dropping that argument is caught.

## ResetOfUnitsNotStoppedTests

Drives `perform` for a reset whose `systemctl stop` fails, with the real
`unit_is_stopped` reading a patched `systemctl show`. The tolerated cases (not
loaded, already inactive) must end with the slot emptied. Every other state, a
missing property, a failing `systemctl show`, one colour tolerated and the other
stuck, and any stop error that is not a failed exit (a missing binary, a
permission error, a timeout) must raise with nothing wiped, not even the read of
the content volume name. `sabotage_branchleft_slot.py` loosens each of these in a
scratch copy and requires the suite red against a baseline run of the untouched
copy, then green.

## SlotVolumeNamesTests, StartCreatesSlotVolumesTests, RealEnsureSlotVolumesTests

`start` creates the slot's external volumes before it starts the unit, since
nothing else does. `_slot_volume_names` is tested as a pure function of a
compose text: this slot's data volume, one content and one adapters volume,
and nothing else (another slot's data volume, near-miss data names, the mail
spool, path-shaped names, keys outside the top-level `volumes:` block, two
content or two adapters volumes). `perform` is tested with `FakeSlotOps` for
the order (create, then start) and for what must never create: `stop`, and
`reset`. `RealSlotOps.ensure_slot_volumes` is tested with `subprocess.run`
patched: the exact `docker volume create <name>` argv with `check=True`, a
timeout and no shell; the same argv again on a second start; no compose file,
a symlink or a FIFO creates nothing; a refused file creates nothing; a failing,
missing or hanging `docker` raises, and a failed or timed-out create raises
`VolumeCreateFailed` with docker's stderr on one line (newlines collapsed,
control and non-ASCII characters replaced, cut short, absent stderr tolerated,
one stderr line out of `main`).

`DataVolumeOwnershipTests` covers the owner of the data volume's `_data`
directory against a scratch volume root, with `os.fchown` patched (a test
process is not root) to record the inode it was given: the slot's uid and gid
(and another slot's), after the last create, on the directory only, once even
across a repeat start, never on content or adapters or when the compose file
names no data volume, a link or non-directory refused and not followed (also
when swapped after the open), a missing directory or volume root an error, and
a failed chown stopping the start before the unit. `reset` never chowning is
asserted in `ResetOnVolumesThatDoNotExistYetTests`.

`VolumeCreateTimeoutBudgetTests` pins the per-create timeout: a number above
zero on every call (so a removed or `None` timeout fails), exactly 5 s, and the
total at most half the broker's 30 s default. The 30 s is a constant in the
test, guarded against `services/broker/src/config.ts` by a test that skips when
that file is not beside the directory (the sabotage copy). The sabotage script
proves the removed, `None` and 60 s timeouts and the stderr rows red.

## ResetOnVolumesThatDoNotExistYetTests

A slot never started has no volumes. `reset` of it, run for real against a
scratch tree, must empty the slot directory, create nothing under the volume
root and run only `systemctl`.
