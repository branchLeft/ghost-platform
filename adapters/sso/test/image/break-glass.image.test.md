# break-glass.image.test.mjs

## Concurrent fresh-token logins

express-session's `res.end` override flushes `Set-Cookie` before the
session store's write completes, so a client acting on the cookie
immediately (any redirect- or page-follower, not a test artefact) can be
refused on its very next request. This never showed up sequentially — it
needs concurrent logins racing the same store to open the window. Every one
of these must succeed; a single 403 here is the race, not flake.

One round is not a reliable regression check by itself: measured against a
build with the overlay missing, a single round of 8 came back clean (a
false pass) on close to half of tries — failures cluster within a round
rather than landing at a steady per-login rate, so treating each login as an
independent 50/50 coin understates how often a whole round slips through.
Looped over `ROUNDS` rounds, a fresh-container measurement of exactly this
shape (1 CPU, in-container load, 20 independent runs) came back 0/20 false
passes — a small sample, so read it as evidence this shape catches the
regression reliably rather than as a guaranteed bound.
