# refusingAdminApi.ts

## refusingAdminApi

An interim `AdminApiClient` that refuses every call, so the service can be
installed and started on a demo host before the real client exists.

`configure()` runs after a colour has started and before its lease is
written or its drain flag is cleared (`app.ts`). Rejecting there sends a
fresh build down the existing reset-and-retry path; the retry is refused
the same way, and the slot ends in `error` with a `503`. A colour swap is
refused and the slot stays on its current colour. No lease is ever
written, so the router never sends a reader to a site this refused. The
reason is in the journal: the app logs the rejection's message on both
paths.

`/status`, `/reset` and `/stop` never call this seam, so they work
normally beside it.

The real client replaces this module by pointing `BROKER_ADMIN_API_MODULE`
at it; nothing else changes.
