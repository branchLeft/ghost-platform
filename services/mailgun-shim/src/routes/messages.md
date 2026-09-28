# messages.ts

## Reply-To and Sender are not checked

Reply-To is deliberately NOT checked here — it names where a
reply goes, not who sent the mail, and Ghost lets admins set any
newsletter reply-to freely (email-address-service.ts's validate()
allows it self-hosted). Refusing a foreign one would refuse
legitimate mail: only From and the envelope sender identify the
sender.

Sender is never taken from the tenant; From is the checked
identity. There is no Sender check here because there is nothing
left to check: parseMailgunMessageFields (mailgunFields.ts) drops
every h:* key that nodemailer's own normalisation would fold into
'Sender' before it ever reaches `fields.headers`, on any spelling —
matching, foreign, duplicated, padded, differently cased. Ghost's
own request always carries a canonical `h:Sender` equal to its own
From (mailgun-client.js:65,71, forks/Ghost tag v6.55.0), so nothing
legitimate is lost by dropping it unconditionally rather than
validating a value that would only ever restate the check above.
