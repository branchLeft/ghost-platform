# serverStartupNoIpv6RateLimitWarning.test.ts

## No IPv6 key-generator warning

`rateLimit.ts`'s custom `keyGenerator` builds all three of its mounted
routers (messages, events, suppressions) at startup, before
`app.listen()` — express-rate-limit validates a custom keyGenerator
synchronously at that point and, finding one that reads the request IP
without the `ipKeyGenerator` helper, logs `ERR_ERL_KEY_GEN_IPV6` rather
than throwing. That made it a startup warning nobody read rather than a
boot failure anyone would notice — this spawns the real entrypoint and
checks the warning is gone from both streams, not just from a call to
the function in isolation.
