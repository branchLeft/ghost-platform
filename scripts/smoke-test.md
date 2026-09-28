# smoke-test.sh

## Why these choices

Boots the image against SQLite (dev/smoke-test only -- see `README.md`;
production tenants use Cloud SQL MySQL), waits for a strict HTTP-200
readiness check (not just a TCP connect, since a TCP-only check is
misleading for Ghost's migration lock), then reports boot time and idle
memory so they can be compared against the platform's measured baseline
(~1s warm cold start, ~180MB idle).

Runs the container on a deliberately non-default host port (4200 -> a
non-default container `$PORT` of 4200 too) specifically to demonstrate
that the image honours `$PORT` rather than assuming the upstream default
of 2368.

Sets `BRANCHLEFT_ALLOW_LOCAL_STORAGE=true` because this smoke test doesn't
configure `S3Storage` -- that's the entrypoint's fail-closed storage
guard's explicit, deliberate local-dev escape hatch (see
`docker-entrypoint.branchleft.sh` and `scripts/test-storage-guard.sh`,
which exercises the guard itself, both the blocked and permitted paths).
