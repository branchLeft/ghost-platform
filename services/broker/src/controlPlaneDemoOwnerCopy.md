# controlPlaneDemoOwnerCopy.ts

## copyPassphraseToOwner

Sends the owner the viewing passphrase of a demo whose slot is healthy and about to go LIVE, with its hostname, slot
and expiry, to the address in `OWNER_DUE_DILIGENCE_EMAIL`.

Order matters: the provisioning step calls this before it sends the prospect's
arrival mail and sends that mail only after this returns. If the owner's copy
fails it throws and the prospect's mail is not sent, so the owner always holds
a passphrase the prospect holds. An unset or invalid address sends nothing.

Logs carry the slot and a reason code only, never the passphrase or an
address. The mailer's own error is dropped for the same reason.

The mailer is a seam (`OwnerMailer`): the broker package has no mail
dependency, and the control plane supplies the path it already sends the
arrival mail over.
