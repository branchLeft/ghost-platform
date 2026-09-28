# serverStartupNoOutboundConnection.test.ts

## The real entrypoint never dials out

test/noOutboundConnection.test.ts proves `createApp()` never dials out,
but `src/server.ts` has real top-level code of its own — `loadConfig()`,
`createSqliteStore()`, `createThrottle()`, the SIGTERM handler — none of
which that test exercises, because it builds the app directly rather
than running the actual entrypoint.

A version of this test that catches a top-level dial is still
insufficient on its own: the deleted worker never dialled at startup,
it dialled once per QUEUED ROW, on a tick loop. A test that enqueues
nothing and lives under a second stays green for exactly that shape
restored. This version enqueues a real message through the child's own
HTTP API AND its SMTP front door — both are real ways in, and a dial
made only on SMTP acceptance stays invisible to a proof that submits
over HTTP alone — (a file-backed store, not `:memory:`, since the
property under test is what the real entrypoint does with real state)
and keeps the child alive for several seconds afterward — comfortably
longer than any plausible tick interval a re-introduced worker loop
would use — before asserting silence and only then sending SIGTERM.
