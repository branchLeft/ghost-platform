# noOutboundConnection.test.ts

## No outbound connection

The story's own Done sentence: "A test asserts the spool makes no
outbound connection, and it is proven by sabotage: restore the old
delivery worker and the test goes red."

This patches the one primitive every TCP client in Node bottoms out on
— net.Socket#connect (nodemailer's SMTP transport included: it is built
on net.connect/tls.connect, both of which construct a Socket and call
this method) — so it catches an outbound dial regardless of which
library made it, not just the specific worker.ts/smtp.ts shape this
story deleted. The test's own HTTP client (`fetch`, against the shim's
own loopback port) necessarily also goes through this method, so calls
targeting the shim's own bound port are the expected baseline; anything
else is exactly what "no outbound connection" means here.
