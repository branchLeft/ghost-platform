# Sweego webhook receiver

Receives Sweego's signed `complaint` callbacks, keeps a minimal record of each
verified one in a capped queue, and hands the queue to the collector on a
private drain port. It never dials out. Node built-ins only: the package has no
runtime dependency.

## What it does

`POST /webhook` on the public listener:

1. Path and method: anything else is 404 or 405.
2. Body: refused with 413 when the declared length is over 16 KiB, or when the
   bytes received pass 16 KiB. This runs before any verification, so an
   oversized request is never buffered.
3. Signature: HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`
   with the base64-decoded secret, on the raw bytes before any parse.
   Constant-time compare, length-guarded; every secret is tried against every
   candidate with no early exit. Missing header or no match: 401, nothing stored.
4. Window: timestamp at most 5 minutes ahead and 2 hours old, else 401.
5. From here the sender holds the secret, so its requests are dropped with 200
   rather than refused (a refusal makes Sweego retry): a repeated `webhook-id`
   or `event_id` (replay), a body that is not a JSON object, an `event_type`
   other than `complaint`, a complaint with no usable outcome id.
6. Otherwise the record is appended to the queue, then the ids are added to the
   replay set, then 200. Queue full, or any error: 503 with `Retry-After`.

Stored per verified complaint, and nothing else: outcome id (the payload header
named by `WEBHOOK_OUTCOME_HEADER` if set and present, else `swg_uid`), complaint
class (a short lower-case token from `reason`, else `unknown`), and the
receive time in epoch seconds. The recipient and every other field are dropped.

### What the public endpoint lets through

- An unauthenticated caller gets 401 for any request that does not carry a valid
  signature inside the window; 404/405/413 for a wrong path, method or size.
  Nothing is stored, logged with content, or counted beyond a counter.
- A caller holding the secret can enqueue records, bounded by the 5 MiB queue
  cap and the 50,000-entry replay cap (both answer 503 when reached; neither
  evicts).
- No caller can read anything: the public listener has no read route and the
  drain routes do not exist on it.

### Drain API

A separate listener on `WEBHOOK_DRAIN_HOST:WEBHOOK_DRAIN_PORT`. The bearer token
is checked first, constant-time, before the route or any parameter is looked at.

- `GET /drain?after=N&limit=M`: records with `seq` above N (default: the last
  acknowledged), oldest first, at most 500.
- `POST /drain/ack` with `{"through":N}`: releases records up to N once the
  collector holds them. This is the only way room is made; nothing is evicted.
- `GET /stats`: counters and queue size.

Delivery to the collector is at-least-once: a failure between the queue write
and the replay write costs a duplicate on Sweego's retry, never a loss, so the
collector must treat a repeated outcome id as the same complaint.

## Configuration

All by environment variable. Secrets and the token are file paths.

| Variable | Meaning |
| --- | --- |
| `WEBHOOK_HOST`, `WEBHOOK_PORT` | public listener; a specific address, never a wildcard |
| `WEBHOOK_DRAIN_HOST`, `WEBHOOK_DRAIN_PORT` | drain listener; private address, never a wildcard |
| `WEBHOOK_SECRET_FILE` | base64 signing secret from the Sweego dashboard |
| `WEBHOOK_SECRET_FILE_PREVIOUS` | optional second secret, for rotation |
| `WEBHOOK_DRAIN_TOKEN_FILE` | bearer token, at least 32 characters |
| `WEBHOOK_STATE_DIR` | the one writable directory: queue, replay set |
| `WEBHOOK_OUTCOME_HEADER` | optional name of our correlation header in the payload |
| `WEBHOOK_HEADERS_TIMEOUT_MS`, `WEBHOOK_REQUEST_TIMEOUT_MS`, `WEBHOOK_KEEP_ALIVE_TIMEOUT_MS` | read timeouts (5000, 10000, 5000) |

A missing or malformed value stops startup. The secrets and token are read once
at start; rotation is a restart.

Rotation: add the new secret as `WEBHOOK_SECRET_FILE` and move the old one to
`WEBHOOK_SECRET_FILE_PREVIOUS`, restart, rotate at Sweego, then remove the
previous file within one retry window and restart again.

## Container

`Dockerfile` builds a non-root image whose process writes only to
`WEBHOOK_STATE_DIR`. Run it with a read-only root filesystem, all capabilities
dropped and one writable volume for the state directory.

## Needs that are not in this service

- An image build and publish workflow (copying the sibling services' pattern;
  it publishes, so it is an owner merge).
- The proxy block: 16 KiB request body cap, a dedicated low per-IP rate-limit
  zone, and the hostname. Caddy's read timeouts are server-wide, so the edge
  decides and flags the all-sites effect.
- The host compose project, the firewall rule limiting the drain port to the
  collector, DNS, and placing the secret and the drain token. All owner-gated.

## UNPROVEN

Built to the documented format; each point below is an assumption until seen
against real Sweego traffic.

- Sweego source IP ranges: none are published, so there is no allow-list.
- Signature format: whether the header carries a `v1,` prefix and whether it can
  carry several signatures. Both are accepted: bare base64, `v1,<base64>`, and a
  space-separated list, any one of which may match.
- Whether a retry is re-signed with a fresh id and timestamp or resent as is.
  A resent original older than 2 hours is refused by the window.
- The `complaint` payload shape is inferred from the shared event format:
  `event_type`, `event_id`, `swg_uid`, `reason`, and a `headers` object keyed by
  header name. A real payload may differ, in which case verified complaints are
  dropped and counted as `ignored_event_type` or `ignored_no_outcome_id`.
- Whether the payload echoes our custom header or only `swg_uid`.
- Timestamp tolerance on Sweego's side, and what response code, timeout and
  auto-disable behaviour it applies to a failing receiver.
- Key rotation: Sweego documents no overlap, so the two-secret scheme above is a
  design assumption.
- Retries beyond the documented 1 h 40 min: a complaint is lost after that much
  receiver downtime.
