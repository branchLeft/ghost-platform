# test_break_glass_textfile.py

Tests `branchleft-break-glass-textfile.py` with two stand-in executables, one
for `docker` and one for the host wrapper, each logging every call. Run with
`python3 -m unittest discover -s adapters/sso/scripts/host -p 'test_*.py'`.

- The contract: the exact file for an open, a closed and an unknown tenant,
  written by hand.
- Only `report --tenant <slug>` is ever run on the wrapper, and `docker` only to
  list; a clean environment reaches both.
- A tenant that is refused, slow, empty, not JSON, several lines, the wrong
  tenant, a bad state, lane or time, carrying a clock while closed, a repeated
  key or an oversized line has no series; the readable tenants keep theirs.
- A report carrying a reason, a reference, a grant id or an identity is refused
  whole, and none of those words or values reaches the file.
- Only running Ghost containers are read; a stopped tenant's series is gone on
  the next run; a listing that fails leaves no series.
- The write is by a temporary file beside the textfile, whose name does not end
  in `.prom`, then a rename; a failed write removes the old file; the directory
  is never created.
- The two systemd units: a oneshot run as root of the installed name, a 60
  second timer that does not replay a missed run.
- Sabotage: the real source is broken in one named place and the matching
  check must go red (a verb other than `report`, closed written on failure, an
  unknown field let through, the tenant a report names trusted, stale series
  kept after a failed listing or write, the environment passed on, a container
  that is not Ghost read). Each break must apply to exactly one place, so a
  refactor cannot leave a sabotage that proves nothing.
