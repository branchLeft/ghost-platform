# serverStartupSplitListener.test.ts

Starts the real compiled `dist/server.js` as its own process, with a clean
environment. With `SHIM_DRAIN_PORT` set, `GET /drain` and `POST /drain/ack`
answer on that port with the drain token, and the mail API port answers 404 to
both even with the token; the Mailgun-shaped API and `/healthz` stay on the
mail API port. With `SHIM_DRAIN_PORT` equal to `PORT` the process exits non-zero
before listening. Unit tests of the two apps and of `loadConfig` cannot see an
entrypoint that mounts the drain handover on the mail listener anyway.

The drain listener binds `SHIM_DRAIN_HOST` and nothing else. One case starts the
process with `SHIM_DRAIN_HOST=127.0.0.1`, then connects to the drain port on
`127.0.0.1` (must answer) and on a non-loopback IPv4 address of the machine
(must be refused with `ECONNREFUSED`). That second connection is the control:
a listener that binds every interface, which is what `listen(port, cb)` with no
host does, answers on it and the case fails. Under `CI` a machine with no such
address fails the case instead of skipping it. Further cases start the process
with the host unset, empty, `0.0.0.0`, `::` and a hostname, and require a
non-zero exit before any drain listener.
