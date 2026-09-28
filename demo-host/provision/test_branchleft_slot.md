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
