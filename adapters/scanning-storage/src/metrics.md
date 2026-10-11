# metrics.js

## Why this exists

The monitoring stack is Prometheus and Alertmanager with no log shipper, so
a log line cannot raise an alert. Everything the adapter can observe about
its scanner is therefore also a metric, and the alert rules in
`branchLeft/shared-infra` read these names. **The names, types and label
values below are a contract**: renaming one silently disables a rule, so a
change here is made together with `hetzner/monitoring/render.ts` there.

## Configuration

Export is off by default and writes nothing.

| Key (`storage__<feature>__...`) | Meaning |
| --- | --- |
| `metricsTextfilePath` | Absolute path of the file to write, ending `.prom`. The host's node_exporter textfile collector reads a directory of such files. |
| `metricsTenant` | The value of the `tenant` label on every series. Required with the path: two tenants on one host with no label would collide. |

Setting only one, a relative path or a path not ending `.prom` logs a line
containing `SCANNER_METRICS_MISCONFIGURED` and exports nothing. One process
exports to one file; Ghost builds one decorator per storage feature in the
same process and they all report into the same registry, so the series are
per process, not per feature.

The file is rewritten every 15 seconds by write-then-rename, so a reader
never sees half a file. A failing write is logged once and retried; it never
affects an upload. Mounting the directory into the container and reading it
on the host are infrastructure, not this module.

## Series

Every series carries the `tenant` label. Counters and gauges are written at
zero from the first write, so the first increment of a counter is visible to
`increase()`.

| Name | Type | Other labels | Meaning |
| --- | --- | --- | --- |
| `scanning_storage_unconfigured_instances` | gauge | | Adapter instances in this process with no verdict source. Above zero means every new upload on that feature is refused. |
| `scanning_storage_uploads_refused_total` | counter | `reason` = `unconfigured`, `verdict`, `sealed` | Uploads refused at the request. `unconfigured`: no verdict source. `verdict`: a verdict named known material. `sealed`: the same bytes were refused before. A hold later resolved to a refusal is not counted here. |
| `scanning_storage_verdicts_total` | counter | `classification` = `csam`, `harmful-abusive-material`, `test`, `no-known-match`, `unavailable`, `other` | Every verdict outcome. A timeout or a thrown error counts as `unavailable`. A classification outside the vocabulary counts as `other`. |
| `scanning_storage_verdict_errors_total` | counter | `kind` = `timeout`, `error` | Verdict requests that exceeded the budget or threw. A subset of the `unavailable` verdicts. |
| `scanning_storage_verdict_duration_seconds` | histogram | `le` | Time waiting for a verdict, a timeout included. |
| `scanning_storage_held_uploads` | gauge | | Uploads accepted and held unserved, waiting for a verdict. |
| `scanning_storage_held_oldest_age_seconds` | gauge | | Age of the oldest held upload, 0 when none. A hold resumed after a restart is dated from its quarantined bytes. |
| `scanning_storage_held_stuck` | gauge | | Holds that stopped retrying and need an operator. |
| `scanning_storage_metrics_written_timestamp_seconds` | gauge | | When the file was last rendered. A reader that finds this old knows every other value is stale. |

## What this does not claim

- A series that is absent says nothing: no file, no export configured, or a
  host whose collector is not wired. A rule must not read absence as a fault.
- The gauges are as of the last write. A process that dies leaves its last
  values in the file; `scanning_storage_metrics_written_timestamp_seconds`
  is how a reader tells.
- The verdict channel's own health is observed only as the outcomes above.
  There is no separate "channel up" probe.
