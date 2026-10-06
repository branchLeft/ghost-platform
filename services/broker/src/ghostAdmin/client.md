# client.ts

## ghostAdminClient

The broker's way back into a demo's Ghost after the first build: the
owner's ruling of 2026-10-04 ("keep the site owner's personal staff access
token, captured at first build, visible to the prospect and cancellable by
them").

### Why a staff token, not an integration key or a stored password

Checked against the pinned Ghost (6.55.0) before building:

- **An integration key cannot change settings.** Ghost's admin API keeps an
  endpoint allowlist for integration tokens
  (`core/server/web/api/endpoints/admin/middleware.js`,
  `tokenPermissionCheck`), and it lists only `GET` for `settings`. All three
  settings below came back `403`.
- **A stored password cannot sign in again.** Only the first sign-in after
  setup skips staff device verification (the user has never signed in).
  Every later one answers `403 Needs2FAError` and emails the prospect a
  code, because `security:staffDeviceVerification` defaults to `true`.
- **The owner's staff access token works.** Ghost blocks it only from
  deleting all content, transferring ownership and resetting
  authentication. The prospect sees it in their own profile and cancels it
  by regenerating it.

### First build

Recognised by Ghost's own answer to `GET authentication/setup/` (`status:
false`), polled until Ghost has finished booting. Anything stored for the
slot is dropped first: it belonged to a tenancy whose data is gone. Then:

1. a random 32-byte password, created and used inside one function, never
   logged, written or returned;
2. setup, with the prospect's email and the placeholder name and title;
3. the one sign-in that skips device verification, then the owner's id and
   staff token through that session, then sign-out;
4. the token stored in the slot's private folder (`keyStore.ts`);
5. the settings applied with the token.

### Later configures

A colour swap or retry finds the site already set up and uses the stored
token. If none is stored, or Ghost answers `401`/`403` because the owner
regenerated it, configure throws `AdminAccessLostError`. A swap catches
that, leaves the demo on its current colour and answers `503` with the
reason; the reason is also in the journal.

### The settings

`render-core`'s `renderSettings`: both code-injection boxes (always named,
even empty, so a prospect's own injection is cleared again) and
`members_support_address`. Each is read back from Ghost's answer; Ghost
stores an empty box as `null`, which counts as empty. Any mismatch is a
failure, so a setting Ghost silently declined (one that waits on email
verification, for example) never passes for applied.

### Addressing Ghost

Over loopback to one colour's own port, with the site's own `Host` and
`X-Forwarded-Proto: https`, so Ghost answers instead of redirecting to its
configured URL. The sign-in carries an `Origin`, which Ghost requires.
