# rateLimit.ts

## tenantRateLimiter

Applied per-route (not globally) so it runs after Express has matched
`:domain`, letting it key by tenant rather than by IP — a shared Cloud
Run egress IP shouldn't let one noisy tenant throttle another's sends.
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
