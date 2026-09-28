# validate.ts

## assertShape

Checks that every field `validate()` or a renderer reads exists, has the
right JS type, and — for the container-runtime numbers — the right range,
for the whole descriptor at once, before any format or cross-field rule
below assumes it. Also rejects a key nothing declared, at every object
level, so a descriptor is exactly its schema and nothing riding along with
it. Each union's own `kind` is not re-checked here: `assertDiscriminant`
above (and `checkInv1`, for `codeInjection`) already guarantee it is one of
the variant's declared literals, so the branches below only need to check
the fields *that variant* carries.

## assertNonEmptyPath

A traversal segment reaches outside whatever directory the render core
placed the tenant in, and it must be absolute — every path this schema
carries names a fixed location under `/data`, `/var/spool` or similar, so a
relative one would resolve against whatever directory happened to be the
working one when a renderer's output ran, not a place this validator ever
inspected. A backslash is rejected outright rather than treated as a
separator: this schema's paths are Linux container paths, which never need
one, and allowing it would let a ".." segment hide from the forward-slash
split below (`"..\\x"` is a single segment to `split('/')`).

## assertNotJsonScalar

Ghost parses environment values as JSON where it can, so a value that
happens to *look* like a JSON number, boolean or `null` (a tenant name of
`2024`, say) arrives as that type rather than the string the adapter's own
config schema expects, and the adapter disables itself, fail-safe
(`adapters/sso/README.md`). Refused here, on every break-glass value that
reaches an env var, rather than left for a real tenant to trip over.
`JSON.parse` throwing means the value is not valid JSON at all — safely a
string as far as Ghost's own parser is concerned — so only a *successful*
parse into one of the three scalar kinds is refused.

## imagesWithBreakGlassAdapter

Digest-pinned image refs known to carry the break-glass SSO adapter — an
exact-match allowlist, not a version comparison: a `DigestPinnedRef` carries
no ordering a renderer could compare (two builds of the same Ghost version
tag can differ only in whether the adapter is baked in), so "does this pin
carry the adapter" is a fact only the caller who tracks what has actually
been built and rolled out can supply — the same reasoning as `ownedDomains`
above, applied to image history instead of DNS. Selecting the adapter
(`breakGlass.kind = "enabled"`) for an `image` outside this list is refused
by `validate()`: on such an image Ghost cannot find the adapter and does not
boot at all — measured against the real image; see
`adapters/sso/README.md`'s "Turning it on for a tenant" section.

Optional, and absent means empty — the existing callers of this interface
(the broker, today) predate break-glass entirely, and requiring every one of
them to be edited in the same change that adds this field would make an
additive schema change look like a breaking one. Absent or `[]` are both the
same safe posture — "no image has been confirmed to carry it yet" — which is
not a caller error the way an empty `ownedDomains` is, since a demo/platform
zone must always resolve inside `ownedDomains` and no equivalent "must
resolve" rule holds here.

## validateZoneConfig

Every field of `zones` is caller-supplied, unbranded input — unlike the
descriptor, nothing upstream of `validate()` has ever checked it — so an
`ownedDomains` of `[]`, `[""]`, `[" x"]` or `[".x"]` must be refused here
rather than silently making every "theirs" fqdn look like it is outside
every owned domain (an empty or malformed entry can never match anything, so
`isOutsideOwnedDomains` would wrongly say "outside" for a domain that is
really inside), and `ownedDomains` arriving `undefined` (an unset env var,
split and never checked) must throw a named error rather than a raw
`TypeError` from `.some`. `demoZone`/`platformZone` are checked the same
way: each must be well-formed *and* equal to, or a subdomain of, an owned
domain — otherwise an empty `demoZone` renders every demo's `siteUrl` as
`https://<sub>.`, which is exactly as ill-formed as the fqdn checks below
exist to reject. Well-formedness is checked against each value *normalised*
(trailing dot trimmed, lowercased), matching how `isEqualToOrSubdomainOf`
already compares them below — a zone config is caller-authored, not
attacker-supplied, and case or a trailing dot is not itself a defect the way
it is in a "theirs" fqdn (see `validateHostname`'s own comment on why *that*
string is held to an exact-case standard).

## servedHostnameOf

The hostname a certificate-admission decision (Caddy's on-demand-TLS ask
endpoint) should admit for this descriptor, or `null` if this descriptor
must never reach that decision at all.

A demo's `ours` hostname renders under the demo zone, but is never admitted
here: demo slots sit under a platform wildcard certificate, so asking
per-hostname for one would both waste an issuance and put a slot name into a
public, append-only CT log for good — which the never-reuse rule for slot
names cannot tolerate. `zones.demoZone` is therefore never read by this
function: the demo branch returns before anything would use it. A `theirs`
fqdn that is itself one of the platform's own owned domains is refused for
the same reason `validateHostname` refuses it as a hostname at all — a
"custom domain" is only a custom domain if it is genuinely outside every
domain the platform owns, not merely a different-looking label of one.

Deliberately narrower than `validate()`: a caller deciding whether to admit
a TLS handshake has no business validating, or having an opinion on, every
other field a descriptor carries.

## validate

Validates a complete descriptor against the caller's zone configuration: the
zone configuration itself first (it is exactly as unchecked as the
descriptor, and every hostname check below trusts it), then closed-set
discriminants and unknown-key checks (so nothing below reads a field a
wrong `kind` would not have, or trusts a key nothing declared), then the
schema version, then every field's own format and range, then the three
named invariants, the code-injection hostname precondition, the per-tier
variant rules, the hostname/gate and siteUrl/hostname consistency checks,
and finally the break-glass identity and image-ordering checks. Returns the
same descriptor on success so a caller can chain it into `render()`; throws
on the first violation found rather than collecting every one, because both
callers reject before any side effect regardless of how many things are
wrong.
