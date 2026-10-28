# rateLimit.ts

## tenantRateLimiter

Applied per-route (not globally), and always after `requireTenantForDomain`,
so it keys by tenant rather than by IP — a shared Cloud Run egress IP
shouldn't let one noisy tenant throttle another's sends. Order matters:
the key is the `:domain` segment of the URL, which the caller chooses. Placed
before authentication, a stranger could spend a tenant's budget with requests
that carry no valid key. After authentication, that segment is the
authenticated tenant, so only that tenant's own requests count against it.
Falls back to IP only for requests that don't even parse to a domain
(malformed paths never reach a tenant-specific limit anyway).

The IP fallback goes through `ipKeyGenerator` rather than the raw
address: an IPv6 client can draw from a whole /64 or larger, so keying
on the bare address would let it open a fresh bucket per address and
walk straight past the ceiling this limiter exists to enforce. The
helper groups IPv6 addresses by network prefix and leaves IPv4
addresses untouched.

Limits are generous placeholders for a service with no production
traffic yet (doc 13 §4's volume band is low hundreds of recipients);
revisit once real send/poll volume exists to tune against.
