# test_health_collect.py

Tests `branchleft-health-collect.py` with real local HTTP servers for the
sidecars and one stand-in `docker` executable that logs every call, its
environment and its standard input. Run with
`python3 -m unittest discover -s portal/host -p 'test_*.py'`.

- A clean run: one `docker ps` and one `docker exec -i <id> node
  dist/collector/healthMain.js` for the whole run, nothing else on the command
  line, one report with every colour's text in order as it came.
- A colour that answers 500 or 404, is not at the metrics path, sends more than
  16 KiB, is silent or dripping past the limit, sends text that is not UTF-8, or
  is not listening is reported as `null`, the tenant is still handed over, and
  the run exits `1`.
- A whole estate that is down still hands over a report of `null`s, so the
  portal's old readings are replaced rather than left to read as healthy.
- No console container, two, a malformed id or a failing `docker ps` hands
  nothing over and fails the run. A collector that exits non-zero fails the run.
- The children get `PATH` alone.
- Only `<slug>=<private IPv4 address>[,<address>]` is taken: a public address, a
  name, `https`, a missing port, another path, a query, a login, IPv6, three
  colours, an empty colour, a bad or missing slug and an empty string are usage
  errors that run nothing, and one bad argument or a repeated slug among good
  ones stops the run before any fetch.
- The two systemd units: a oneshot that takes its tenants from the host file, a
  60 second timer that does not replay a missed run.
- Sabotage: the real source is broken in one named place and the matching check
  must go red (an unread colour left out of the report, a tenant that could not
  be read skipped, nothing handed over, success reported with an unread colour,
  no status check, no size cap, no deadline, any number of containers, a failed
  collector forgotten, the environment passed on, a public address, a repeated
  slug or any slug taken). Each break must apply to exactly one place.
