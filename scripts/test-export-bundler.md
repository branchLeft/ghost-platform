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
- a tenant with Stripe connected: fake Stripe Connect keys (a `sk_test_`
  key) in the live settings travel into the copy, the colour boots on them,
  and it cannot reach `api.stripe.com`
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
- the three extensions each come out `complete` in the manifest, with the
  count the seed puts in: two media objects, two members (one with a
  subscription) and one comment. The rendered stack names an object-storage
  media address (`storage__images__wrappedConfig__cdnUrl`), the way a
  platform tenant's does; without one the media extension reports `failed`
  and the manifest says so. The archive carries each: `media_addresses.json`
  lists both public addresses, `members.json` the subscribed member and
  subscription, `comments.json` the comment

## The fake object storage, and the sabotage

The media probe is a HEAD against the tenant's public media address, run from
the host over https. The script starts
`services/export-bundler/test/helpers/fakeMediaStorage.ts` for it (Node runs
the TypeScript directly), with a certificate made for the run that only the
bundler process trusts (`NODE_EXTRA_CA_CERTS`). It answers 200 with a size for
the two seeded objects and 404 for anything else, and logs each request; the
script checks the log, so a status that did not come from a real probe fails.

`EXPORT_PROOF_MEDIA_500=1 ./scripts/test-export-bundler.sh <image>` is the
sabotage: the fake answers 500 for the seeded video. The bundler cannot tell
that from an outage, lists the object as unchecked and reports `media` as
`partial`, so the script must exit 1. A run that is green with the switch on
is not proving the media extension.

The "refused while undrained" control case is proven at the unit level
(`test/unit/exportRunner.test.ts`), against `runExport`.
