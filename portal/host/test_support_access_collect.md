# test_support_access_collect.py

Tests `branchleft-support-access-collect.py` with real local HTTP servers for
the exporters and one stand-in `docker` executable that logs every call, its
environment and its standard input. Run with
`python3 -m unittest discover -s portal/host -p 'test_*.py'`.

- A clean run: one `docker ps` and one `docker exec -i <id> node
  dist/collector/main.js` per host, nothing else on the command line, each
  host's text piped through unchanged, the collector's run line in the journal.
- A host that answers 500 or 404, is not at the metrics path, sends more than a
  megabyte, is silent past the limit, drips its answer past the limit, or is not
  listening has nothing handed over, not even empty text; the next host still
  runs and the run exits `1`.
- A 200 with no text is a normal run: the empty text is handed over as it is.
- No console container, two, a malformed id or a failing `docker ps` hands
  nothing over and fails the run. A collector that exits non-zero fails the run
  and the next host is still handed over.
- The children get `PATH` alone.
- Only a private IPv4 address with a port and `/metrics` is taken: a public
  address, a name, `https`, a missing port, another path, a query, a fragment, a
  login, port `0`, IPv6 and an empty string are usage errors that run nothing,
  and one bad address among good ones stops the run before any fetch.
- The two systemd units: a oneshot that takes its addresses from the host file,
  a 60 second timer that does not replay a missed run.
- Sabotage: the real source is broken in one named place and the matching check
  must go red (empty text handed over for an unreadable host, no status check,
  no size cap, no deadline, any number of containers, a failed collector
  forgotten, the environment passed on, a public address or a name taken). Each
  break must apply to exactly one place, so a refactor cannot leave a sabotage
  that proves nothing.
