# descriptor.ts

## The tenant descriptor

The one schema both reconcilers (the Pulumi component, via CI, for paying
tenants; the broker, via HTTP, for demos) render from.

Every difference between a demo, an entry tenant and a professional tenant is
a tagged union variant, never an absent field — an optional field would let
two descriptors differ by omission, which is how promotion quietly becomes a
migration instead of a re-point. `validate()` in `./validate.ts` is the only
place the cross-field rules are checked; a caller that re-implements one of
them is exactly the failure mode this shared core exists to remove.

## Sending identity spec

The descriptor's sending identity: "a local part per demo, not a subdomain
per demo". A demo's own arm carries only the local part that makes one
slot's address distinct on the one domain every demo shares (`ZoneConfig`'s
own `demoMailDomain` in `./validate.js` — never a field here, or a demo could
carry a domain of its own by construction, which its containment argument
forbids). A tenant signs its own domain instead, and needs the DKIM selector
that domain's DNS record names — `demo` has no field for either, so
`validate()`'s unknown-key check refuses a demo carrying one at all, not
merely a demo whose selector or domain happens to be wrong.

## Break-glass spec

The break-glass triple this schema carries: the broker's Ed25519 public key,
the tenant name a token's `aud` must equal, and the one identity the adapter
is allowed to produce a session for. Derived, like `codeInjection` — nobody
hand-sets these three, and `validate()` refuses a descriptor carrying one or
two of them (`enabled` requires all three; there is no partial variant to
construct). `disabled` for every demo: a demo visitor already holds admin on
their own disposable slot, so there is nothing for a support identity to
reach that they cannot already reach — see `checkTierVariants` in
`./validate.ts`.

## Tenant stack descriptor

`TenantDescriptor` without `ownerEmail`: the shape a paying tenant's own
repository commits and the Pulumi component validates, with
`validateTenantStack()` in `./validate.ts`. The owner's address is a
person's, and a tenant repository holds no personal data, so for a paying
tenant it travels as a secret beside the descriptor. `render()` names it in
the `secrets.env` template as `GHOST_OWNER_EMAIL`, and it reaches the host
only in `/etc/branchleft/<slug>.env`. Nothing renders its value, for any
kind: no artefact contains it, which `test/owner-email.test.ts` checks with a
sentinel address.

A demo keeps `ownerEmail` inline. The broker holds it in its own store and
never commits it, and it creates the owner from it. A promotion's
`transform()` still returns a full `TenantDescriptor`, and the caller removes
`ownerEmail` before the result goes into a tenant repository.
