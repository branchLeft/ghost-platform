# serverStartupPortInUse.test.ts

Starts the real compiled `dist/server.js` as its own process with one of its
three ports (mail API, SMTP front door, drain) already held by the test, on the
same address the entrypoint binds for that port. The process must exit non-zero,
name `EADDRINUSE` on stderr and never log the line for the listener that could not
bind: `"event":"listening"` for the mail API and SMTP ports,
`"event":"drain_listening"` for the drain port (the mail API and drain listeners
bind in the same tick, so the mail API line can precede a drain failure).

Express passes a failed bind to the callback given to `listen` instead of
throwing it, and the SMTP front door's `listen` was not awaited. Before this
case existed, a taken mail API port logged `listening` and kept running with
no listener behind it, and a taken SMTP port logged `listening` and then died.
Either one lets a test, or a supervisor, talk to whichever other process owns
the port. The startup tests that choose ports through `helpers/freePorts.ts`
rely on a collision ending the child with `EADDRINUSE` so they can run again on
fresh ports.
