# mail-credential.test.ts

## The per-slot spool credential

Proves workspace#1740: two demo slots render two different spool credentials,
`slot-<uid>.<demoMailDomain>`, on both the SMTP username and the Mailgun-route
domain, while `mail__from` stays `<localPart>@<demoMailDomain>`. The credential
is keyed on the uid and not on the local part, so a slot keeps its credential
when its local part changes and two slots cannot share one by choosing the same
local part.

A paying tenant's credential is its own sending domain, unchanged. The tenant
goldens and `parity.test.ts` are the byte-level proof of that; the cases here
pin the rule. The sabotage that proves the test bites: make `credentialDomainOf`
return `sendingDomainOf(...)` and the slot cases go red; restore it and they go
green. The shim side of the proof, that a per-slot row refuses another slot's
key, is in `services/mailgun-shim/test/shim.integration.test.ts`.
