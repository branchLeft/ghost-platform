# config.ts

## Unauthenticated connections per source

Bounds one source address's own share of the unauthenticated pool that is
admitted WITHOUT waiting, checked before the global backstop above. A
credential-less peer holding (or churning — replacing each connection the
instant it's refused or evicted) idle connections can never occupy more
than this many instantly, however many it opens: churn defeats a purely
time-based deadline (reconnect faster than it expires) and a purely
global count-based cap doesn't need many addresses to exhaust. A single
legitimate Ghost source is not always at 0 or 1 concurrent connections —
several members signing in at once each open their own connection, and
scrypt's own per-AUTH cost means more than a few can be simultaneously
unauthenticated for real — so a burst past this cap waits rather than
being refused; see the two settings below.

## Recipients per message

Ghost's SMTP transactional sender always addresses exactly one recipient
per message (LLD-6 §03) — 50 is generous headroom above that, not a fit
to any real send this listener should ever see, and bounds one
credential's envelope fan-out per message. smtp-server rescans its whole
rcptTo array on every RCPT, so an unbounded envelope costs quadratic CPU
on this connection and starves every other submitter sharing the process
while it runs. A message over the cap is refused mid-envelope with a
temporary failure (RFC 5321), never trimmed and accepted: trimming would
return a false success for the recipients silently dropped. This is the
SMTP front door's own cap — the HTTP Mailgun-shaped route carries
Ghost's bulk newsletter sends and has no recipient cap of its own.
