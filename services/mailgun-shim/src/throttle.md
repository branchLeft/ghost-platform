# throttle.ts

## createThrottle

Token bucket in messages/hour. Starts with exactly ONE grace token, not a
full bucket and not zero.

Not a full bucket: this gates warm-up sending, so a freshly started
worker must not be allowed to burst up to the hourly cap on its first
tick — capacity above the grace token accrues from zero over the
configured window, the same as every tick after it. A restart-to-bypass
attack is still bounded to one extra message per restart, which is a
much smaller bypass than the full hourly cap a truly full bucket would
hand out on every restart.

Not zero either: at this component's own production default (50/hour),
a bucket starting at literally zero tokens makes the FIRST message ever
sent through a freshly started spool wait up to 72 seconds (1/50 hour)
for a token to accrue — before anything has actually burst, there is
nothing to protect against yet. That broke this story's own Done
criterion ("a message enqueued ... is handed over on a waiting drain
request within a second of enqueue") for the cold-start case
specifically. The fixed property is narrower than the Done sentence
reads standalone: "within a second" holds only while a token is
actually available — a SECOND message sent immediately after the first,
before any refill, still waits out the ladder like any throttled send
is supposed to. That is the throttle working as designed, not a residual
gap; the grace token exists for the one case where there is nothing yet
to legitimately throttle.

This bucket and LLD-6 §05's demo-mail "two ceilings" (load-bearing at
§08) are not unrelated: both ultimately defend mx1's shared IP
reputation (§05: "IP reputation is the thing that has to be actively
defended, by ceilings, by warm-up discipline"). What changes is where
that defence has to live. Today, one spool total, a per-spool bucket
and an estate-wide bucket are the same thing. Once every host has its
own spool (LLD-6's own end state), a per-spool bucket stops bounding
anything at the IP: N hosts each independently allowed up to
messagesPerHour is N times the intended estate rate against the one
address that carries the reputation. The warm-up ceiling then belongs
at the single egress point every host's mail eventually converges on
(whatever drains every spool and submits to mx1) rather than here —
that convergence point doesn't exist yet, so moving it is future work,
not something this per-spool bucket can do on its own.
