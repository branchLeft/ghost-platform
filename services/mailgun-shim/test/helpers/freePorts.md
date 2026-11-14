# freePorts.ts

Ports for the tests that start the compiled `dist/server.js` as a child
process. An in-process listener binds port 0 and reads the port back, and
every such listener in this suite does. The entrypoint cannot be told to:
`PORT` and `SMTP_LISTEN_PORT` are read as numbers and 0 means unset, so the
test has to name the ports before the child binds them.

## freePorts

Returns `count` distinct loopback ports. Every probe stays bound until all the
numbers are read, so two of them are never the same number. Probing them one
after another, closing each as it goes, could return the same number twice.

## withFreePorts

Runs a whole start on fresh ports, and runs it again on a new set if it failed
with `EADDRINUSE`, which is what a child's stderr says when another process took
a port in the gap between the probe and the child's bind. That gap cannot be
removed; the retry makes a loss in it harmless. Any other failure, and the
last collision after five attempts, is rethrown unchanged, so a real startup
defect is never retried into a pass. The attempt runs more than once, so it
creates its own database directory and stops its own child each time.

The failure must name `EADDRINUSE`: start-up helpers that reject with the
child's stderr when it exits early already do.
