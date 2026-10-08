# shim.outcomes.integration.test.ts

## The stand-in delivery host

The SMTP sink accepts both messages the collector helper submits, which is all
a real delivery host's acceptance proves. The two tests then show the
difference between that and an outcome: with nothing reported, mailgun.js's
events call (the client Ghost bundles) returns no `delivered` and no `failed`
event, so Ghost's delivered count cannot move on acceptance alone. Reporting one
recipient delivered and one permanently failed over `POST /drain/outcomes` makes
exactly those events appear, with the failure's code, and the failed address
lands on the bounce suppression list.
