# mailgunFields.ts

## Header key normalisation

nodemailer's own header-key normalisation, not reimplemented. Any h:* key
this shim later stores as a header reaches nodemailer's mail-composer via
addHeader, which keys each custom header by this same normalisation before
appending it — verified against the installed package
(nodemailer/lib/mime-node/index.js, MimeNode.prototype._normalizeHeaderKey:
strips control characters, trims (which also removes NBSP/BOM — both are
ECMAScript whitespace — but not a zero-width space, which is not), then
lower/upper-cases into nodemailer's canonical form; 'sender', 'SENDER',
' Sender' and 'Sender ' all normalise to 'Sender'). The method reads only
its `key` argument, so calling it straight off the prototype needs no
MimeNode instance. `@types/nodemailer`'s own .d.ts for this path declares
the public shape only — `_normalizeHeaderKey` is private/undocumented — so
it is reached through a narrow local cast rather than a `declare module`
augmentation, which would have to redeclare (and could drift from) that
published type.

## isValidHeaderFieldName

RFC 5322's field-name grammar: one or more printable US-ASCII characters
(33-126) other than ':', the character that ends a field name on the
wire. An `h:*` multipart field name that fails this can't be emitted as a
real header line at all (a literal colon reads as the name/value
separator to any RFC 5322 parser, so `h:Sender:` becomes the line
`Sender:: value`, which a parser reads as field name `Sender`), or
normalises inconsistently across parsers (a control character, NBSP,
ZWSP or BOM in the name) — refusing the whole class up front, rather than
only the specific shapes demonstrated so far, is what closes it against a
shape nobody has tried yet.

## Header injection characters

CR, LF and NUL are the three characters that let one header-bound value
escape its own field: RFC 5322 forbids a bare CR or LF inside a field
body (folding whitespace is CRLF *followed by* WSP, a well-formed shape
nothing in this shim produces — an unfolded, bare CR or LF is always
either a second header line or a truncated one), and a downstream
C-string-based consumer can treat an embedded NUL as an early
terminator. Checked on the raw value the caller sent, before
%recipient.*% substitution (routes/drain.ts's toWireMessage) or any MIME
decoding a downstream renderer might still apply to it — the SMTP front
door (smtpFrontDoor.ts) reuses this same check on mailparser's already
MIME-decoded values, since an encoded-word can decode to a CRLF that was
never literally on the wire.

## sanitizeRecipientVariables

recipient-variables carries member-supplied data (a signup name, not
anything the tenant wrote), and Ghost does not sanitise it before it
reaches here — a member's own `name` comes straight from their signup
request body (members-api/controllers/router-controller.js:1046,
forks/Ghost tag v6.55.0) with no CR/LF/NUL stripping on that path. From,
subject and every h:* value are refused outright on the same characters
(containsHeaderInjectionChars, above) because those are tenant-authored
and a tenant can simply be asked to resend a corrected request — but
refusing here would fail an entire Ghost newsletter batch (real Mailgun's
batch size is 1,000 recipients) over one member's uncontrolled name, and
Ghost retries the batch a fixed number of times before giving up
(email-service/batch-sending-service.js:43's MAILGUN_API_RETRY_CONFIG)
rather than dropping just that recipient. Replacing the character instead
keeps the rest of the batch delivering, and is still safe against
injection: the sanitised value is what %recipient.*% substitution
(routes/drain.ts's toWireMessage) later splices into subject, html, text
or a header, so nothing it produces can carry a CR, LF or NUL through to
become a second header line.

recipient-variables is also caller-controlled JSON (`JSON.parse` on an
untrusted string), so its shape is not guaranteed to match
ParsedMessageFields' declared `Record<string, Record<string, string>>` —
a value can be a nested object or array with a string somewhere inside
it. This walks whatever JSON.parse actually returned, recursively, so a
string buried under an extra level of nesting is still sanitised rather
than silently passed through because it didn't match the declared shape.

## Ghost email id

Ghost's own `v:email-id` is always the Email model's row id, a
MongoDB-style ObjectId minted by bson-objectid's
`ObjectId().toHexString()` on create — every Bookshelf model's `id` is
assigned this way (forks/Ghost tag v6.55.0,
models/base/utils.js:38, models/base/plugins/events.js:260) — and
threaded through unchanged from there (batch-sending-service.js's
`emailId: email.id` → mailgun-email-provider.js's `id: emailId` →
mailgun-client.js's `messageData['v:email-id'] = message.id`, only ever
set when `message.id` is present). It is always exactly 24 lowercase hex
characters, never anything a tenant chooses, so checking the fixed shape
(rather than only refusing the three injection characters) loses nothing
legitimate.

## Sender and From are never taken from the tenant

Neither Sender nor From is ever taken from the tenant, on any
spelling nodemailer will later fold into one of those two names:
Ghost's own request always carries 'h:Sender' equal to its own
From (mailgun-client.js:65,71, forks/Ghost tag v6.55.0 —
`from: message.from` and `'h:Sender': message.from` are the same
value), and the top-level `from` field is the one checked
identity (routes/messages.ts, senderBelongsToTenant) — an h:From
is never itself a candidate to become the visible sender, so
nothing legitimate is ever lost by dropping both unconditionally.
The value is never inspected past the injection check above,
because there is nothing a dropped header could still do. This
runs at parse time, before a batch is ever enqueued — the one
point every HTTP-side delivery mechanism this shim could route a
message through has to pass, so the guarantee "no tenant-supplied
Sender or From header is ever stored" doesn't depend on which
one is currently wired up.
