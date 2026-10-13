# verdict-source.js

## Default is closed

`resolveVerdictSource` is the one place that decides what answers a
verdict question. There are three outcomes:

- `storage__<feature>__verdictSource=in-process-fake` selects the
  in-process fake, seeded by `refuse`, `unavailable` and `resolvePath`.
  This is the demo, dev and test path, and it is explicit.
- `storage__<feature>__verdictSource=production` selects the production
  client (`production-verdict-client.md`) over a transport that code passes as
  the second argument, `{ transport, logger }`. The entry file passes none
  yet, so naming `production` there is the third outcome below: no source,
  every upload refused. Budgets are `verdictConnectTimeoutMs` and
  `verdictTotalTimeoutMs`; a value set but not a positive number is also no
  source, with the cause in the result's `configError`.
- Anything else, including unset, selects no source at all. The decorator
  then refuses every new upload with a typed 503 (it never seals a digest,
  never writes to quarantine, and never reaches the wrapped adapter), and
  the verdict client it is given answers `unavailable`, so a hold left by
  an earlier process stays held rather than being promoted.

The seed keys alone (`refuse`, `unavailable`, `resolvePath`) do not select
the fake. A deployment that sets them without the flag is unconfigured.

Every write Ghost makes goes through `save()` or `saveRaw()`, so the refusal
is not limited to an editor's upload: it also stops an on-demand resized
image that does not exist yet, a bookmark thumbnail and an inlined external
image. Existing files, and resized variants that already exist, keep being
served.

Timeout and outage are a different case and are not touched here: a
channel that is configured but slow or unreachable answers `unavailable`,
and the upload is accepted and held unserved until a verdict arrives.

## Alerting

Two log lines, both on the error stream, both carrying `SCANNER_UNCONFIGURED`:

- once at construction, `ScanningStorageAdapter: SCANNER_UNCONFIGURED ...`
- on every refused upload, `ScanningStorageAdapter: UPLOAD_REFUSED_SCANNER_UNCONFIGURED ...`

Alert on the second; the first says the state exists before anyone uploads.

A log line cannot raise an alert here, so both states are also metrics, when
export is configured (`metrics.md`): `scanning_storage_unconfigured_instances`
above zero is the first line, and `scanning_storage_uploads_refused_total`
with `reason="unconfigured"` is the second.
