# test-export-bundler.sh

## What this proves

Proves the export bundler's real lifecycle against real containers, on the
MySQL tier: a "live" MySQL 8.0 (the pinned server image, TLS required, as
db1 is) holding one tenant's Ghost database, seeded by a real Ghost, with a
real owner and a real suspended Administrator support account.

The tenant is described the way the platform describes one: a descriptor
(slug, backup recipient) and a rendered stack directory (`compose.yml`,
with the break-glass support identity in its environment) beside a secrets
env file and an image env file. The bundler takes no identity, recipient or
environment from its own flags.

What this proves, through the built CLI:

- refusals, each starting nothing (no colour, no scratch copy, no network,
  no archive, no drain flag, no audit entry): no grant; an
  `--age-recipient` that is not the descriptor's; the Owner as the rendered
  support identity; the support account still suspended
- the export colour runs against a scratch copy of the tenant's database,
  never the live one: Docker reports its database host as the run's own
  scratch container, and it never holds the live database's password
- with a due member welcome email and a newsletter mid-send seeded on the
  LIVE database, Ghost's boot-time automation poll and newsletter resume
  act on the copy (the copy's rows change) while the live rows are
  byte-identical before and after the export
- defence in depth on the copy: no reachable mail transport, the scheduler
  disabled (a post due during the export is still scheduled on the copy)
- no tenant secret in any process's argv while the colour runs
- no Docker log of tenant data: the mysqldump container (caught while it
  streams), the scratch database, the colour and its relay all run with
  `LogConfig.Type=none` and no log file
- the run network is `--internal`: neither the colour nor the scratch
  database can open a connection off the host, and the colour publishes
  nothing -- a relay on 127.0.0.1 is its one way in
- the archive is age ciphertext that decrypts to real content; the
  manifest names the recipient; the audit record names the grant, the
  support identity, the fingerprint and the archive's SHA-256
- on success, and on Ctrl-C at the token prompt, nothing the run created is
  left: no colour, no scratch container, network or volume, no env file

The "refused while undrained" control case is proven at the unit level
(`test/unit/exportRunner.test.ts`), against `runExport`.
