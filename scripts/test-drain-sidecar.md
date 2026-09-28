# test-drain-sidecar.sh

## What this proves

Proves the drain-sidecar's contract against a real Ghost container: with
the broker's drain flag set, the sidecar answers 503 "drained" while Ghost
itself still answers 200 -- the whole reason a slot's health comes from the
sidecar rather than from Ghost
(`ghost-platform-docs/19-try-it-now-design/02-broker-and-slot.html` §01b).
With the flag cleared, the sidecar answers 200. It also proves the two ways
the sidecar must fail closed: flag clear but Ghost not yet ready, and a
flag directory it cannot read.

It also proves `/metrics` (per-tenant health and version) against this same
real Ghost: the reported version matches what Ghost's own site endpoint
says directly, a colour told the right intended version reports a real
match, a colour told the wrong one reports a real mismatch, and a
genuinely drained colour exposes neither version gauge at all.

Both images under test are handed to this script rather than derived from
it, so the proof always runs against what the platform actually builds:
the platform image is `docker build .` from this repo's own root
Dockerfile (the upstream Ghost base plus the branchLeft entrypoint wrapper
-- the image a real tenant boots), not a second-hand copy of its `FROM`
line.

The sidecar under test always shares Ghost's network namespace (`docker run
--network container:<id>`), matching the design's own term for how the two
processes see one address -- including the unreadable-flag-directory state,
which needs a genuinely healthy Ghost behind it: a sidecar that fails open
on an unreadable flag would otherwise fall through to asking Ghost and get
a 200, and an isolated network would hide that by making even the correct
implementation answer 503 for the wrong reason (Ghost unreachable, not the
flag). Docker requires port publishing to be declared on the container that
owns the namespace, so every health port answered on this shared namespace
is published on the Ghost container up front, even though the sidecar
containers that will answer on them don't exist yet at that point.

Ghost's own `url` is configured https here, as any real tenant's is (LLD-4
§U3b): a plaintext probe with no `X-Forwarded-Proto` header gets redirected
onto a port nothing is listening on TLS for, so every curl call below
carries the same header the edge sets on every real request.
