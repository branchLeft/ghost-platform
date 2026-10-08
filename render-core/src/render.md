# render.ts

## Render step overview

The descriptor-to-artefacts render step: pure and total, same seven
artefacts, from the same functions, for every kind and both reconcilers.
`render()` performs no I/O — see `test/render.test.ts`'s own no-I/O
assertion, and `test/dependency-closure.test.ts`, which already refuses any
import of a Node built-in (`node:fs`, `node:http`, …) as a bare specifier
leaving the package, so an I/O call could not be added here without failing
that test first. (That is also why this module implements its own tiny
`dirname` below rather than importing `node:path`.)

**No secret ever appears in an artefact.** `render()`'s own parameter is a
`TenantDescriptor`, which carries no secret field to begin with — the
schema's only credential-shaped values (`gate.argon2idHash`,
`backup.encryptionRecipient`) are not secrets by the estate's own definition
(a hash and a public age recipient) — so every place a real secret belongs
is rendered as a `${VAR:?…}` reference into a file this package never
touches (`environment.ts`) or as a blank key name in a template an operator
fills in by hand (`secrets.env` below, from `renderSecretsTemplate`).

**No owner address appears in an artefact either.** A paying tenant's
template also names `GHOST_OWNER_EMAIL`, the owner's address, which is
personal rather than secret but must stay out of a tenant repository all the
same (descriptor.md#tenant-stack-descriptor). `render()` never reads
`ownerEmail` for any kind; `test/owner-email.test.ts` renders a sentinel
address and checks every artefact for it.

**The seven artefacts:**

1. `compose.yml` — `compose.ts`
2. `secrets.env` — the *names* this kind needs in
   `/etc/branchleft/<slug>.env`, never their values
3. `image.env` — the digest-pinned image reference (today rendered by
   `branchleft-deploy`, not by this component — folded in here because
   nothing about the value is secret and a reconciler that already writes
   six artefacts should not have to special-case the seventh out of band)
4. `provision.sh` — the host commands (volume creation for a paying tenant;
   informational only for a demo — see `renderProvisionScript`)
5. `edge.json` — `edge.ts`
6. `ghost-settings.json` — `settings.ts`
7. `identity.json` — `identity.ts`

**Known Done-criterion conflict, not resolved here — see the PR body.** The
story's own Done means says tenant zero's rendered Compose and environment
are byte-identical to what `infra/tenant` renders today. `compose.ts`'s own
doc comment explains why that cannot hold at the same time as the ruling
that blue/green applies everywhere, demos included: today's renderer emits
one service on one port; this one necessarily emits two. The environment
*values* this module renders match for every key `TransportSpec` can carry;
`environment.ts`'s own doc comment on `transportEnvironment` names the four
keys it cannot yet, and why.

## Provision script

The exact root-run command that must create a paying tenant's two named
volumes, owned to its uid, before its unit can start — ported from
`infra/tenant/index.ts`'s `hostProvisioningCommand`, at the path
`RUNBOOK-tenant-onboarding.md` actually invokes it from (a bare command name
would fail "command not found" as a standalone script).

A demo renders no equivalent command: its one directory is host-provisioned
once, at demo-host build time, never per recycle, and never keyed by `slug`
(a demo's slug is a throwaway per-lease value). `provision.sh` still exists
for a demo, per the story's own Done means ("all seven artefacts... for a
demo"), but is informational rather than a command to run.

## assertAllocationShape

Re-checks the fields the broker's own reconcile handler already guards
before calling a `Renderer` (no port to pick, no uid to compute), plus the
two fields `renderProvisionScript`/`renderImageEnv` interpolate into shell
and env file text (`slug`, `image`) — so this function is safe to call
directly, outside that handler, by a caller with no `validate()` of its own
(a test, a descriptor rendered for review). Allocating the *right* uid/port
for a given slot is still the caller's job, not this one's; see
`compose.ts`'s own comment on why the descriptor's own fields are the only
source `render()` ever reads a uid or a port from.

## render

`descriptor` must already have passed `validate()` — `render()` does not
re-run it (that would make every call two passes over the same cross-field
rules) but does re-check every field it interpolates into shell, env or
Compose text directly, via `assertAllocationShape`, so a caller that
skipped `validate()` gets a named refusal here rather than a malformed
artefact.

Returns the seven artefacts directly — the shape `services/broker/src/
render.ts`'s `Renderer.render()` seam expects, and what the story's own Done
means names: "`render(descriptor)` returns all seven artefacts".
`renderEdgeSiteBlock`/`renderSettings`/`renderIdentity` stay separately
exported for a caller (a test, a future reconciler) that wants one
artefact's typed value rather than re-parsing it back out of `content`.

`themeCsp` (the strict content policy) defaults to `THEME_CSP_UNAVAILABLE`
— the fail-soft posture — so every existing caller of
`render(descriptor, zones)` keeps compiling and keeps rendering the
report-only policy exactly as before. No caller in this repo passes a
computed set yet: the harness that derives one at theme-admission time does
not exist here — wiring a real value through is that story's job, not this
one's.
