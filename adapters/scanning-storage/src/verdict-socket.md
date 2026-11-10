# The local verdict socket

## What it is

The line between the scanning decorator, inside Ghost, and the verdict host end
(`../verdict-host/`), on the same machine. The decorator's side is
`socket-verdict-transport.js`, which plugs into `ProductionVerdictClient`
(`production-verdict-client.md`). The framing, shared by both sides so they
cannot drift, is `verdict-socket-frame.js`.

The address is an absolute filesystem path to a unix socket. The transport
refuses anything else, so it cannot be pointed at a remote machine.

## Framing

One JSON object per line, at most 1024 bytes, version 1. One connection
carries one ask.

| Direction | Line |
| --- | --- |
| ask | `{"v":1,"op":"ask","key":"<PDQ hash>"}` |
| reply | `{"v":1,"key":"<PDQ hash>","classification":"...","matchType":"..."}` |
| refusal | `{"v":1,"error":"bad-ask" \| "busy" \| "unavailable"}` |

`key` is the canonical base64 of exactly 32 bytes and nothing else: a path, a
name or a tenant value is refused on sight and queues nothing. `matchType` is
present only when the safety service gave one.

## Correlation

The reply's `key` is copied by the host end from its own record of the hash it
settled, and the transport passes the reply on unchanged: nothing stamps the
asked key onto an answer. A connection that closes before its verdict is
forgotten by the host end, so a late verdict cannot reach a later ask. The
client holds any reply whose `key` differs from the key it asked. The tests
that prove this over the real transport are in
`test/unit/verdict-host-channel.test.mjs`.

## Failure

Every outcome that is not a recognised reply inside the client's budget is a
hold (`production-verdict-client.md`): a refused connect, an error line, an
unreadable line, a silent host end, a reply of another version. A host end that
has no verdict inside its own wait replies `unavailable` and keeps the hash
queued; the decorator holds the upload and asks again later.
