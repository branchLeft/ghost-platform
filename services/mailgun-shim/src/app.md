# app.ts

## createApp

Assembles the Mailgun-shaped endpoints Ghost's bulk-email path calls (doc
13 §1.3/§2.4), the drain handover (routes/drain.ts) mx1 — or a test
collector standing in for it — calls to take queued mail off this host,
plus an unauthenticated health check and an unauthenticated metrics
endpoint. Deliberately no global body-parser: the messages route reads
the multipart body itself via busboy, and adding express.json()/
urlencoded() ahead of it would consume the request stream before busboy
sees it; the drain ack route mounts express.json() on itself instead
(routes/drain.ts).

Ghost joins `bulkEmail__mailgun__baseUrl` on its `.origin` only (doc 13
§1.3's `baseUrl.origin` note — the mailgun.js client is constructed with
`url: baseUrl.origin`, discarding any path), so every Mailgun-shaped
route below is mounted at the app root rather than under a configurable
prefix.
