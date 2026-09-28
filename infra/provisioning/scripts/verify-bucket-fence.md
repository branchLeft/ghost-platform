# verify-bucket-fence.py

## Module overview

Prove a bucket fence works, in both directions, against the live bucket.

WHY THIS EXISTS AT ALL, AND WHY IT IS NOT A LIST OF DENIALS.

A single `AccessDenied` is not evidence that a fence works. It is returned by a
working fence, by a credential that was revoked, by a typo in a key id, by a
region mismatch in the SigV4 scope, and by a bucket that lives in a different
project entirely. Those are different facts with one wire response, and a
denial recorded without distinguishing them has already been mistaken here for
proof of per-bucket key scoping that does not exist on this backend: the bucket
that returned it was in a different project, so the denial was the project
boundary and said nothing about the key's scope.

So every denial check in this file carries a CONTROL: a probe on the *same
credential*, sent over the *same transport*, that must succeed. If the control
does not succeed, the denial is reported as INCONCLUSIVE, never as a pass --
because a key that reaches nothing tells you nothing about the fence, and a
control that travelled some other client licenses nothing about the one the
probe used. The one check with no control available is labelled as such and
proves only that the bucket is not world-readable.

And every fence has a second direction that matters just as much: the key that
is supposed to keep working must still work. A policy that denies everybody is
not a fence, it is an outage -- on the backup bucket, a silent one that surfaces
at the next restore.

THE CHECK THAT MATTERS MOST IS REVERSIBLE, AND RUNS FIRST.
Bucket policies on this engine ARE enforced -- proven directly, live, with
nothing but `curl --aws-sigv4`, in the finding `DWELL_SECONDS` below exists to
act on. A live run once read a `Deny` this file wrote as reaching nobody --
neither the key it exempted nor the key it should have refused -- and that
observation was recorded as the opposite finding. It was not one: the read was
taken inside this engine's own read-path cache, seconds after the `Deny` was
applied, which is exactly the reading a stale cache produces regardless of
whether the policy is enforced.

So the open question `--diagnose-policy-engine` asks is narrower than "is
anything enforced at all": does naming one access key in a statement separate
that key from another one, once every read is held past that cache? An engine
that enforces no policy, an engine on which every credential in a project is
one principal, and an engine that simply does not implement `NotPrincipal` can
still each produce a `Deny` that appears to reach nobody, even correctly
dwelled, if the statement genuinely denies neither key -- and those three have
opposite consequences: the last leaves a fence rebuildable, the first two leave
no bucket policy able to separate anything and put the boundary at a separate
Hetzner project. So the mode is built around one rule -- a probe whose result
only ONE of those engines could produce -- and the long comment above
`diagnose_policy_engine` sets out how each window earns it.

`--probe-notprincipal` is the narrower question, kept because it is the one the
fence in this repository is actually built on: does this backend read
`NotPrincipal` as an exemption, or as decoration?

`--probe-foreign-grant` IS THE OTHER HALF OF THE ENGINE QUESTION. Every reader
in the diagnostic above is a key belonging to the bucket's own project, so "no
shape constrains the owner's own keys" and "no policy is evaluated at all" are
one observation from inside that project. They are not one fact. An engine that
evaluates policies for foreign and anonymous callers while bypassing evaluation
for the bucket owner's keys produces exactly that output, and this provider
documents two features only such an engine could provide: cross-project `Allow`
grants, and public bucket visibility implemented as an automatically applied
anonymous-read policy with listing denied.

So this mode reads with a credential from ANOTHER project, and refuses to run at
all if that credential resolves to the bucket's own account -- an owner key as
grantee would re-create the blind spot the mode exists to close. It grants
twice: once with a narrow `Allow s3:GetObject` on the probe prefix, and once
with the provider's documented cross-project shape verbatim, because an
implementation that pattern-matches a published template would honour the second
and ignore the first. That difference decides how every policy in this estate
has to be written, so a run that tested one shape would answer the wrong
question. Every document it sends is `Allow`-only and asserted to deny nobody
before it is sent; an `Allow` cannot lock a bucket, and the assertion makes that
a property of the code rather than of the brief it was written to.

Every other guard here, and both guards outside this file, validate a document
against a MODEL of S3 evaluation. None of them touches Hetzner's implementation,
which is undocumented on this point. If its principal match short-circuits
naively -- "a `Principal` field is present and is not me, so this statement does
not apply" inverted, or simply ignored -- then
`DenyBucketConfigurationExceptOperator` matches EVERY principal including the
operator's. The apply succeeds. The second PUT comes back `AccessDenied`. The
bucket is then unrecoverable from inside the account, with `DeleteBucket` denied
by the same statement, and every offline guard will have passed on the way in.

So this mode applies a policy whose only `Deny` is scoped to an unused object
prefix and names no bucket-resource action at all, then reads an object back as
the operator AND as a foreign key. Denied for the operator means `NotPrincipal`
does not exempt on this engine and the real fence would have locked the bucket.
Allowed for the operator means nothing on its own -- a statement the engine
ignores entirely produces that same read -- so only the pair decides it, and a
foreign key that was also allowed is INCONCLUSIVE here, never a pass. That
misreading has already been made once and recorded as an answer.

The probe policy cannot lock anything, because it contains no statement on the
bucket resource -- so `PutBucketPolicy` and `DeleteBucketPolicy` stay available
to every key throughout, and the probe is removed at the end. That reversibility
is asserted in code before the policy is sent, not assumed.

AND THEN `--preflight`, which resolves each credential's own storage account and
then evaluates the policy against the ARN built from it. Nothing else can:
every principal in a rendered policy comes from one `--project-id` argument, so
the generator's own recoverability check compares a fabricated ARN against
itself and passes for any value at all. Live, an ARN carrying the right access
key under the wrong account names a principal that does not exist --
`NotPrincipal` exempts nobody, the operator loses `PutBucketPolicy` along with
everyone else, and the bucket cannot be recovered from inside the account. One
mistyped digit is enough. `--preflight` writes nothing.

It asks that as an EVALUATION question, through `bucketpolicy.decide`, and not
by reading `NotPrincipal` lists. A working fence contains Deny statements that
name only the operator -- the version-destroying object actions are withheld
from the workload deliberately -- so "this Deny does not name the workload" is
what a correct fence looks like, and a structural reading of it condemns the
policy this repository's own renderer emits.

`--preflight` also exercises the transport every probe uses, on all three
credentials, before anything has been written. A transport that does not work
has to surface where nothing has been written yet, not in the middle of
`--probe-notprincipal`, which applies a policy to a production bucket and
removes it again.

`--apply` then runs the pre-flight and the double PUT in ONE process, so the
guard cannot be skipped by an operator who ran the real `put-bucket-policy` from
a different terminal than the check.

After the policy is applied, the check that cannot wait is `put-bucket-policy`
as the operator, re-PUTting the document just applied: a no-op when it succeeds
and the only warning you will ever get when it does not. Run it before leaving
the terminal, not the next morning.

A PROBE MUST BE SAFE WHEN IT SUCCEEDS. These run against live production
buckets, so every denial check either only reads, or writes back the state the
bucket is already in. That is why the bucket ACL is never set here at all
(`put-bucket-acl` replaces rather than merges, and nothing can assert the
current ACL) and why the versioning probe is behind
`--versioning-already-enabled`: turning versioning on for a bucket that has it
off, with no lifecycle rule, retains every earlier object version indefinitely.

WHY NOTHING HERE SHELLS OUT TO A CLIENT. This backend's storage engine returns
its error documents with an empty `<Message></Message>`, and `aws s3api` v2
exits 255 printing a client-internal error in place of the S3 one rather than
render that. It is not specific to an operation: `get-object`,
`list-objects-v2`, `get-bucket-policy`, `put-object` and `list-buckets` all do
it, for `AccessDenied` and `InvalidAccessKeyId` alike. What does render is the
gateway's own `NoSuchBucket`, which carries a real message -- which is why the
failure looked at first like one broken command. `head-object` renders too,
because a HEAD response has no body to fail on, but it reports a refusal as the
code `403`: an HTTP status rather than an S3 error code, matching no denial set
here, so it was not a way out either. A CLI that cannot render a denial cannot
prove a fence: every denial probe on it came back INCONCLUSIVE -- fail-safe,
and useless as evidence.

So every request this file makes is signed and sent by
`db/provision/objectstorage.py`, the same implementation db1's backup pipeline
uses, reached through `shared_objectstorage.py`. There is no second copy of the
signing to rot, no external client to be missing or too old, and no credential
written to a temporary file for one.

THE HTTP STATUS IS NEVER ENOUGH ON ITS OWN. `AccessDenied`,
`InvalidAccessKeyId` and `SignatureDoesNotMatch` all arrive as HTTP 403, so a
status-only reading turns a dead key into a fence -- the substitution the
controls above exist to prevent. A verdict of `denied` comes from the `Code`
inside the returned error document and from nowhere else, so a response this
file cannot interpret is an `error` whatever its status.

Credentials come from the environment, one pair per role, and are never
accepted as arguments:

    FENCE_OPERATOR_ACCESS_KEY_ID / FENCE_OPERATOR_SECRET_ACCESS_KEY
    FENCE_WORKLOAD_ACCESS_KEY_ID / FENCE_WORKLOAD_SECRET_ACCESS_KEY
    FENCE_FOREIGN_ACCESS_KEY_ID  / FENCE_FOREIGN_SECRET_ACCESS_KEY
    FENCE_GRANTEE_ACCESS_KEY_ID  / FENCE_GRANTEE_SECRET_ACCESS_KEY

The foreign role is any real key in the same project that has no business in
this bucket. It must be a live key with an entitlement somewhere, named by
`--foreign-control-bucket`, or its denials prove nothing.

THE GRANTEE ROLE IS THE OPPOSITE OF THE FOREIGN ROLE. `--probe-foreign-grant`
uses it and nothing else does: it is a key in a DIFFERENT project from the
bucket, and the one thing that makes the grant probe mean anything. The mode
resolves its account from the credential itself and stops if it matches the
bucket's.

`--diagnose-policy-engine` takes the operator and foreign pairs only. It reaches
no verdict about a fence -- a verdict about a fence is a statement about which
credentials it separates and needs all three -- and it establishes the foreign
key is live by reading an object it just wrote with no policy on the bucket,
which is a stronger control than an entitlement in some other bucket.

## Dwell timing

How long a read that matches the state a change is moving AWAY FROM must be
held before the run may draw anything from it, and how often it is re-polled
while held.

NOTHING HERE ESTABLISHES THIS ENDPOINT'S CONSISTENCY GUARANTEES, and that is
the reason the dwell exists rather than a reason to skip it. A policy PUT or
DELETE is confirmed by reading the document back, which proves it reached the
node that answered `GetBucketPolicy`; an object read may be served by
another, and every way that read path can lag biases it towards the state
that held BEFORE the change -- `allowed`, for most windows in this file --
which is the direction that produces the most consequential readings here
from a timing artefact rather than from the engine.

A READ MATCHING THE PRE-CHANGE STATE IS WHAT STALENESS PRODUCES; ONE THAT
DIFFERS IS NOT KNOWN TO BE. So the rule is asymmetric, not a blanket wait: a
read that matches the state a change is moving FROM is exactly what a stale
read path produces, and only counts once it has outlasted that read path's
own cache. A read that differs counts at once -- this is a working
assumption, not a proven law: it holds if the cache lags by at most one
change, but a cache still serving a document from TWO changes ago (this
window's predecessor, not this window's own pre-change state) would also
read as "differs from pre_change" and be trusted wrongly. Nothing measured
here rules that out; every fresh probe object in this file exists partly to
keep that risk as small as a single prior state can make it.

THE TWO DIRECTIONS LAG DIFFERENTLY, and the slower one sets this constant.
Removing a policy was measured clearing between t+10s and t+20s. APPLYING one
is slower: a diagnostic run against this endpoint held the pre-change
`allowed` for 50s in one window and 60s in another before the Deny it had
already stored began to answer. A dwell calibrated on the removal figure
would have read both of those as "the Deny reached nobody" -- which is the
conclusion this whole mechanism exists to stop the tool reaching by accident.
120s is twice the longest application lag observed, not a guess, and not
derived from the removal side.

## s3_error_code

The `Code` of an S3 error document, or None if this is not one.

Parsed rather than pattern-matched, so that a body which is not an error
document -- an HTML page from something sitting in front of the endpoint, a
truncated response, an object whose own contents mention a code -- yields
nothing to act on rather than a code lifted out of prose.

THIS FUNCTION NEVER RAISES, and the response body is the one input here
that an attacker on the far end of the connection chooses. Three bounds,
because capping the input alone does not cap the work:

  1. A `DOCTYPE` is refused outright. Internal entities are the only way a
     small body becomes a large one, ElementTree expands them, and no S3
     error document has ever carried a doctype -- so 500 bytes cannot
     become a gigabyte of `Code`.
  2. The body is capped before parsing, and the code is held to
     `S3_ERROR_CODE` after it.
  3. Anything else the parser can raise comes back as "not an error
     document". A response that cannot be read is one no verdict can be
     drawn from, which is the same answer by a different route.

## classify

Map one response onto `allowed` / `denied` / `error`, with a reason.

THE HTTP STATUS ALONE NEVER PRODUCES A DENIAL. This endpoint answers
`AccessDenied`, `InvalidAccessKeyId` and `SignatureDoesNotMatch` with the
same 403 -- a fence, a key that does not exist, and a key signed for the
wrong region are one status code, and reading that code as a denial is the
substitution the controls in this file exist to prevent. The verdict comes
from the `Code` inside the error document and from nothing else, so a
response with no error document in it is an `error` whatever its status.

Anything that is not a clean success or a recognised denial is `error`, and
an error never contributes to a pass. Collapsing an unrecognised failure
into "denied" is the mistake this whole file exists to prevent.

## preflight

Everything that must hold BEFORE a policy is applied, not after.

The check that cannot wait until after the PUT is the account id. Every
principal in a rendered policy is built from one `--project-id` argument,
so the generator's own recoverability check compares a fabricated ARN
against itself and passes for any value at all. Live, an ARN carrying the
right access key under the wrong account names a principal that does not
exist -- so `NotPrincipal` exempts nobody, the operator loses
`PutBucketPolicy` along with everyone else, and the bucket is
unrecoverable. One mistyped digit in the runbook command is enough.

Resolving the account from each credential itself is the only way to catch
it, and it has to happen while the policy is still a file on disk.

Each resolution is a signed request over the transport every probe uses, so
a workstation that cannot make one finds out here, with nothing written,
rather than in the middle of a mode that applies a policy.

## _denied_actions

Which of the actions this credential needs the policy takes away.

WHETHER A CREDENTIAL IS LOCKED OUT IS AN EVALUATION QUESTION. `decide` is
the repository's model of S3 evaluation and the renderer's own
`assert_recoverable` already asks it this way; asking it here as well is
two independent checks of one invariant, which is the intent.

Reading `NotPrincipal` lists structurally cannot answer it. A working fence
contains Deny statements that name only the operator -- the version-
destroying actions are withheld from the workload on purpose -- so "this
Deny does not name the workload" describes the fence doing its job.

Object actions are asked at the object space the fence governs, not at a
concrete key. A key would give a different answer for a statement scoped to
a narrower prefix -- `--probe-notprincipal` applies exactly such a policy,
denying reads under the probe prefix to everyone but the operator -- and
reporting the workload locked out because of it would be false.

This is still a model. `decide` is not Hetzner's engine, a Deny scoped to
some other prefix is not visible at this resource, and the live probes are
what turn any of it into evidence.

## probe_policy

A policy that answers the `NotPrincipal` question and cannot lock anything.

Two properties carry the whole design, and `assert_probe_policy_is_reversible`
below enforces both before it is sent:

  1. No statement names the BUCKET resource. `PutBucketPolicy` and
     `DeleteBucketPolicy` are bucket-resource actions, so no key loses the
     ability to replace or remove this document -- including the key that
     would remove it if the engine turns out to treat `NotPrincipal` as
     naming everybody. That is what makes asking the question safe.
  2. The `Deny` is confined to an object prefix nothing else writes, so a
     misread in either direction touches no real object.

## assert_probe_policy_is_reversible

Refuse to send a probe that could take `PutBucketPolicy` away.

The probe exists because the engine's principal semantics are unknown. It
would be self-defeating to establish that with a document that becomes
unremovable under the very reading it is testing for, so the check assumes
the worst case -- the statement matches every principal -- and requires that
even then, nothing on the bucket resource is denied.

The action check is the second half of that. `PROBE_ACTIONS` holds one entry
because a Deny on any other object action could refuse the delete that
removes the probe object: a run whose policy removal also failed would then
have left an object under a Deny with nothing able to lift it.

## _policy_slot_is_free

Whether a probe may write this bucket's policy slot, or the row refusing.

THE ONLY ANSWER THAT LETS A PROBE PROCEED IS AN AFFIRMATIVE "THERE IS NO
POLICY". A probe replaces whatever is on the bucket and removes it at the
end, so a bucket whose policy could not be READ must not be written to: a
transient 503, a reset connection, a truncated body and `AccessDenied` are
one outcome here, and treating "unknown" as "empty" destroys a fence on the
strength of a failed request.

The third value says a leftover probe policy of this file's own is sitting
there. It matters to a caller that measures the bucket before writing:
reading a "with no policy in force" baseline while a leftover Deny is still
on the bucket measures the leftover.

## _existing_policy_refusal

The row that stops `--probe-notprincipal` on a bucket that has a policy.

NOTHING HERE RESTORES A DISPLACED DOCUMENT. The probe is applied and then
deleted, so a policy it replaced is gone -- there is no undo, and on a
fenced bucket that means the fence is off from that moment on. So
`--replace-existing-policy` permits exactly one thing: replacing a probe
policy this file wrote itself, which constrains nothing and is what an
interrupted run leaves behind. Any other document is refused whether or not
the flag was passed, because the flag cannot make its removal reversible.

Which policy it is therefore decides the whole answer, and the document is
already in hand, so the message says which case this is rather than leaving
the operator to weigh both.

## probe_notprincipal

Ask the live engine whether `NotPrincipal` exempts, reversibly. Returns rows, evidence.

Ordering is the whole safety argument: the object is written before the
probe policy exists, the probe policy is removed before this returns
whatever the answer was, and the probe policy can never deny the removal.

THIS IS THE STEP AN OPERATOR ACTUALLY RUNS, and the render-bucket-fence and
render-media-bucket generators both depend on its answer: if `NotPrincipal`
does not exempt the operator, applying either policy denies the operator
`PutBucketPolicy` and `DeleteBucket`, and the bucket is unrecoverable from
inside the account. A read taken without a dwell reproduces the original
failure exactly -- both roles land inside the read-path cache, both read
`allowed`, and the pair scores `INCONCLUSIVE` -- which is not a false PASS,
but it means this step can never answer the question it exists to answer.

## probe_notprincipal read order

Both reads happen inside the block, so the probe policy is
removed whatever either of them does.

`allowed` IS BOTH THE PRE-CHANGE ANSWER AND THE HOPED-FOR
POST-CHANGE ONE FOR THE OPERATOR, and a single read cannot tell
them apart: a read path still serving the no-policy state
answers `allowed`, and a working `NotPrincipal` exemption also
answers `allowed`. So the operator's reading is held across the
dwell before it counts, the same as the foreign key's: a
`denied` reading cannot be a stale echo of a bucket that had no
policy moments ago and counts at once, on either role.

## _temporary_policy

Applies a policy, and removes it again whatever happens in between.

`applied` says whether the PUT succeeded, and the removal is conditional on
it. `DeleteBucketPolicy` removes whatever document is on the bucket, not
the one this block meant to put there -- so deleting after a refused PUT
would remove a policy this run never displaced, and on a fenced bucket that
is the fence. The engine rejecting a `NotPrincipal` document outright is an
anticipated outcome, not an exotic one: it is case 4 in
`RUNBOOK-bucket-fencing.md`'s own list of ways this engine can differ from
its documentation.

`consequence` is the sentence describing what a document left on the bucket
would do, and it is an argument rather than a constant because the two probe
families leave opposite things behind. A stranded `Deny` refuses reads under
an unused prefix and hurts nothing; a stranded `Allow` leaves a credential
holding access it is not meant to have. Printing the deny sentence over a
leftover grant would tell an operator to relax about the one case that is
actually exposure.

## Which world are we in

--------------------------------------------------------------------------
WHICH WORLD ARE WE IN: what a bucket policy on this engine actually does.

A live run applied a policy whose single statement was a `Deny s3:GetObject`
under the probe prefix, exempting the operator by `NotPrincipal`. The endpoint
accepted it. The operator then read the object -- and so did a key the
statement should have denied. That reading was taken inside this engine's own
read-path cache, seconds after the `Deny` was applied, which produces exactly
this observation whether or not the statement is enforced. It is not evidence
the `Deny` reached nobody; it is evidence the read was taken too soon.

A FOURTH EXPLANATION THE ORIGINAL THREE DID NOT NAME. That live run reasoned
over only these three, all of which are still live once reads are properly
held past the cache -- a genuinely dwelled read CAN still come back
`allowed` for real, if the engine actually behaves like one of them:

  1. This engine stores bucket policies and enforces none of them.
  2. It enforces them, but every credential in a project is one principal --
     so a `NotPrincipal` naming any key exempts all of them, and no policy can
     ever separate two credentials inside a project.
  3. It enforces them and resolves principals per key, and `NotPrincipal`
     alone is unimplemented -- in which case a fence is rebuildable out of
     explicit `Principal` denials.

Under (3) the estate keeps a fence. Under (1) and (2) it has none, and the
only isolation boundary left is a separate Hetzner project.

A PROBE THAT ONLY ONE WORLD EXPLAINS IS THE ONLY KIND WORTH RUNNING HERE.
That is the property the earlier probe lacked, and the reason its `PASS` was
read as an answer when it was not one. Four things give it to these:

  - EVERY WINDOW HAS A BASELINE. Each probe object is read by both keys with
    NO policy on the bucket first. Without that, a denial later could be the
    key, the object, the endpoint or the policy, and this file's whole
    doctrine is that those must not be one verdict.
  - EVERY WINDOW CONFIRMS ITS OWN PREMISE. The stored document is read back
    while the policy is live and compared to what was sent. A 2xx on the PUT
    is not evidence a document is in force, and reads taken against a policy
    that was never stored measure nothing.
  - THE SUBJECT IS THE SAME KEY IN EVERY WINDOW. The foreign key is read in
    all of them; what changes between windows is only WHO the statement names.
    The operator's reads are kept as corroboration, never as the deciding
    evidence -- an engine that exempts the bucket owner would otherwise answer
    every window the same way from the operator's side and hide the question.
  - THE VERDICT IS DRAWN FROM A COMBINATION, NEVER FROM A ROW. A single read
    is consistent with several worlds, and that holds for EVERY window here,
    including the wildcard one. No window is a gate that can end the run on
    its own reading.

The subject key is read under four different names, and the combination of
what happens to it is the answer:

  Window B -- `Principal: [the subject's own ARN]`. Does naming a key deny it?
  Window C -- `Principal: [the other real key's ARN]`. Does naming one key
    deny a DIFFERENT one?
  Window D -- `Principal: [an ARN in an account that is not ours, naming a key
    that does not exist]`. Does a name that can resolve to nothing still deny?
  Window A -- `Principal: "*"`. Does a wildcard deny?

      B denied, C allowed, D allowed -> the name resolves to the exact key.
      B denied, C denied,  D allowed -> both our keys are ONE principal and a
                                        stranger is not: the project is one
                                        RGW user.
      B denied, C denied,  D denied  -> the name is decoration; a Deny reaches
                                        every caller whatever it names.
      B allowed, C denied, D denied  -> the engine matches the complement.
      B allowed, C allowed, D allowed -> a named ARN matches nobody; window A
                                        then splits "only `*` matches" from
                                        "nothing is enforced at all".

WINDOW D IS WHAT SEPARATES THE TWO WORLDS THAT MATTER MOST. Without it, "every
credential in this project is one RGW user" and "the Principal element is
ignored" both land on B denied, C denied, and a single verdict covering both
would be a verdict covering two engines -- the exact defect this file exists
to remove. The consequences differ: under one, a cross-project principal deny
still works and per-project isolation is the answer; under the other, no
principal-based control is possible at all.

WINDOW A RUNS LAST, AND ONLY WHEN THE ANSWER TURNS ON IT. It is the only
window that denies the operator by construction, and the only one whose
statement covers every caller whatever the engine's principal semantics turn
out to be -- so it is the one window with a blast radius that does not depend
on the open question. B, C and D decide four of the five readings without it.
It is sent only in the fifth, where a named ARN denied nobody and the
remaining question is whether a wildcard does any better.

Every probe policy here carries the same safety property as the earlier one
and goes through the same assertion, BEFORE ANY OBJECT IS WRITTEN: one `Deny`,
`s3:GetObject` only, confined to the probe prefix, and NO statement on the
bucket resource -- so `PutBucketPolicy` and `DeleteBucketPolicy` stay
available to every key throughout and no window can lock a bucket.
--------------------------------------------------------------------------

## wildcard_observation

What window A's own two reads show. An observation, never a verdict.

THE FOREIGN READ IS THE SUBJECT, not the operator's. An engine that exempts
the bucket owner from its own bucket policies answers the operator `allowed`
whatever the statement says, so reading the operator's row as "enforced or
not" describes the owner rather than the engine.

This function names no reading and ends no run. A wildcard that denies
nobody is consistent with an engine that enforces nothing AND with an engine
that enforces named principals and does not implement `*` -- worlds that
differ on whether a fence is buildable at all. `principal_verdict` is what
separates them, and it needs windows B, C and D to do it.

## principal_verdict

How this engine matches a principal, from the SUBJECT key's own reads.

All four arguments are the same key reading the same object under four
statements that differ only in who they name:

  `named`    -- window B, the statement names the subject itself
  `other`    -- window C, it names the other real key in this project
  `absent`   -- window D, it names a key that does not exist, in an account
                that is not ours
  `wildcard` -- window A, it names every principal. Consulted ONLY in the
                cell where no ARN denied anybody, and passed empty
                otherwise, because that is the only cell it changes.

Window D is the load-bearing one. Without it "an ARN naming any key in this
project resolves to the one user they all share" and "the Principal element
is not read at all" are the same observation, and they differ on whether a
principal deny discriminates across projects -- which is the whole question
of what replaces the fence.

## _dwell

One read, held until it cannot be explained by a stale read path.

STALENESS ALWAYS BIASES AN OBSERVATION TOWARDS THE PRE-CHANGE STATE. So a
reading that matches `pre_change` -- the answer this exact read gave before
whatever just changed -- is exactly what a stale read path would also
produce, and is retaken until it stops matching or `dwell_seconds` have
passed. A reading that differs from `pre_change` counts on the very first
attempt: nothing stale can manufacture a reading the prior state did not
have.

Every attempt is appended to `evidence` as it happens, and a dwell that
ran at all leaves one more line stating how long it held -- so a
transcript pasted from this run records what was actually waited, not
just what was concluded.

A DWELL THAT HOLDS IS SILENT OTHERWISE, and `--diagnose-policy-engine` can
hold several of these back to back -- minutes of nothing on the terminal,
while the run keeps a live probe policy on a production bucket. Silence
there reads as a hang, not a wait, so a held reading narrates itself to
stderr, once when the hold starts and once per poll.

THE GRANULARITY PREMISE. `pre_change` is only a valid stand-in for "what a
stale read path would echo" if the read path being probed can serve a stale
answer for THIS read at all -- which holds if the cache is scoped to the
bucket policy as a whole, and does not hold for a probe object no read has
touched yet under a per-object cache. This file does not establish which of
the two is true and assumes the former, the more dangerous one to get
wrong: on a per-object cache, a `pre_change` carried forward from a
different probe key's last reading can only ever cost an unneeded hold,
because a fresh object's first read is already live and a match against a
stale-looking `pre_change` is then coincidence, not staleness -- holding it
out does not change what the read settles on. It is never asked to explain
away a read that is real; it is only ever asked to wait out one that might
not be.

## _window

Apply one probe policy, read the object as both keys, remove it again.

`roles` is `(subject, corroboration)`: the key whose reads decide the
reading, and the operator read kept beside it as a control. `assertion` is
the safety property the document has to satisfy before it is sent -- a
`Deny` probe and an `Allow` probe are safe for different reasons and each
has its own, so neither mode can inherit the other's guard by accident.

Returns the observations, or an empty mapping when the window produced no
interpretable evidence. That covers three cases and they are one answer
here: the PUT was refused, what came back off the bucket is not what was
sent, or the document could not be taken off again. Reads under the first
two would be the bucket answering about some other document; after the third
the bucket still carries a policy, so a later window would be measuring a
state nobody established. Each has already been reported as its own row by
the time this returns.

An EMPTY RETURN COLLAPSES THOSE THREE, and a caller that has to run a
following window needs to know which -- the first two leave the bucket clean,
the third does not. `state`, when passed, is filled with the
`_temporary_policy` object so that caller can read `applied`/`removed`/
`fate_unknown` itself. The diagnostic does not pass it and is unchanged.

## _confirmed_reads

Both roles' reads, each held until it cannot be a stale answer.

THE READBACK PROVES THE DOCUMENT REACHED THE NODE THAT ANSWERED
`GetBucketPolicy`. It does not prove the node answering `GetObject` has it,
and nothing here establishes this endpoint's consistency guarantees. Each
role has its own pre-change answer -- `allowed` for a same-project key
reading a bucket that carried no policy a moment ago, `denied` for the
foreign-project grantee `_grant_baseline` established -- and `_dwell` holds
a read that still matches it, because that is exactly what a read path
still serving the state before this window's PUT would produce. A read
that differs needs no holding: nothing stale can manufacture it.

THE `allowed` DEFAULT BELOW IS ONLY CORRECT FOR A WINDOW FOLLOWING THE
CLEAN BASELINE. A caller chaining windows back to back -- as
`_read_the_engine` does across B, C and D -- moves away from the PRIOR
window's own settled reading on every window after the first, not away
from the no-policy baseline again, and must pass that reading as
`pre_change` rather than rely on this fallback.

## diagnose_policy_engine baseline control

THE CONTROL EVERY VERDICT BELOW RESTS ON. With no policy on the bucket,
both keys must be able to read every probe object. Without it a denial in
a window could be the key, the object or the endpoint, and a denial whose
cause is unknown is the substitution that produced this whole programme.

THIS READ IS ALSO ONE A STALE CACHE CAN POISON. When `leftover` above was
true, a Deny probe from an interrupted run was just removed -- and a read
path still serving that removal answers `denied`, not `allowed`. So each
read here is held against `pre_change="denied"` rather than trusted on
the first attempt, whether or not a leftover was actually found: an
`allowed` reading cannot be a stale echo of a just-removed Deny and
counts at once; a `denied` one is exactly what that echo looks like, and
is held before it is allowed to abort the run below as unattributable.

## _read_the_engine

Windows B, C and D, then A only where the answer turns on it.

NO WINDOW ENDS THIS ON ITS OWN READING. Each contributes one read by the
subject key; the verdict comes from the combination. That is why window A no
longer runs first: as a gate it declared `NOT_ENFORCED` -- a claim about the
whole account, and the claim that sends the estate to per-tenant projects --
from one document shape, and an engine that resolves named ARNs while
ignoring `Principal: "*"` is a world where the fence is fully buildable and
would have been reported as one where no policy works at all.

EACH WINDOW'S `pre_change` IS THE PRIOR WINDOW'S OWN SETTLED READING, not a
hardcoded "allowed". `_temporary_policy.__exit__` removes the prior
window's Deny and this window's PUT follows immediately, so what a stale
read path echoes here is the state the prior window settled on, not the
no-policy baseline this function started from -- and only window B is
still moving away from that baseline. Window C moves away from window B's
Deny, so a `denied` reading at C is the prior window's stale echo and has
to be held, not counted on sight because it happens to differ from
"allowed".

## The other half: foreign grant probe

--------------------------------------------------------------------------
THE OTHER HALF: is a bucket policy evaluated for a principal OUTSIDE this
bucket's project?

The diagnostic above answers what a policy does to the bucket-owning project's
own keys. Every reader in it is such a key, so its strongest reading -- no
document reached anybody -- is equally consistent with two engines:

  1. Policies are stored and never evaluated, for anyone.
  2. Policies ARE evaluated, and the bucket owner's own keys bypass evaluation.

From inside the project those are the same output. They are not the same
world: under (2) a separate project per tenant plus a cross-project `Allow` is
a working, documented isolation mechanism, and native public bucket visibility
is the anonymous-read half of it; under (1) neither exists and this provider's
own published examples do not function.

THE PROVIDER'S DOCUMENTATION MAKES (2) THE ONE TO TEST. Its S3-credentials FAQ
documents cross-project grants as a supported approach, with an example whose
principal ARN carries the CREDENTIAL's project id rather than the bucket's.
Its buckets FAQ states that a public bucket is implemented by automatically
applying access policies that grant anonymous read while leaving listing
denied -- a live policy, evaluated for a principal that is not merely foreign
but unauthenticated. An engine that ignored policies wholesale could not offer
either feature.

SO THE SUBJECT HAS TO BE A KEY IN ANOTHER PROJECT, AND THE MODE REFUSES TO RUN
WITHOUT ONE. A grantee that resolves to the bucket's own account re-creates the
exact blind spot this exists to close, and would do it silently: every row
would still print, and the verdict would be about owner keys again.

TWO SHAPES, BECAUSE A SHAPE IS A HYPOTHESIS HERE.

  Window G1 -- `Allow s3:GetObject` to the grantee's ARN, on the probe prefix
    only. The narrowest grant that could answer the question.
  Window G2 -- the provider's documented cross-project document verbatim: the
    principal as a STRING rather than a list, `s3:*` rather than one action,
    and BOTH the bucket ARN and the object ARN in `Resource`.

An implementation that pattern-matches its own published template honours G2
and ignores G1, and "the documented shape is the only one that works" is a
finding that changes how every policy in this estate must be written. A run
that sent one shape would report `no grant is possible` for that world, which
is the same class of mistake as the wildcard gate this file already removed.

BOTH ARE `Allow`-ONLY, AND THAT IS ASSERTED, NOT ARGUED.
`assert_probe_policy_grants_only` refuses any statement whose `Effect` is not
exactly `Allow` before either document is sent.

WHY AN `Allow` CANNOT LOCK THIS BUCKET IS AN EMPIRICAL CLAIM HERE, NOT AN
APPEAL TO S3 SEMANTICS. "An Allow grants and never refuses" is how AWS and
stock Ceph behave, and this engine is neither -- the whole reason this file
exists is that its principal handling matches no documented implementation, so
an argument from semantics is worth little on it. What carries the safety case
is a live run already recorded: four `Deny` documents were
applied to THIS bucket, including one naming `Principal: "*"`, each stored
verbatim and confirmed present, and the operator key kept `PutBucketPolicy`
and `DeleteBucketPolicy` through all four PUT/DELETE cycles. A document that
denies nobody is strictly weaker than a `Principal: "*"` Deny that was
observed constraining nobody. That is the evidence; the `Effect` rule is what
keeps the documents inside it.

WHAT G2 COSTS, STATED WHERE THE SHAPE IS DEFINED. It grants the grantee `s3:*`
on the whole bucket for the seconds the window is open. That is acceptable for
one reason and one only: THE GRANTEE IS OUR OWN KEY. Swap a third party's ARN
in and the same document hands them full control of the bucket. The guard
against that is structural -- the principal must equal the ARN this run
resolved from the grantee credential itself -- and on top of it the operator
has to acknowledge the grantee explicitly with --grantee-is-ours before
anything is written.

AND THE REMOVAL IS OBSERVED, NOT ASSUMED. After each window the grantee reads
again, and must be denied. Without that read, "the grant worked" and "the
grant was never what allowed it" are indistinguishable, and the next run
starts from a bucket whose state nobody established.
--------------------------------------------------------------------------

## documented_grant_policy

The provider's documented cross-project grant, verbatim.

Three things are deliberately NOT narrowed, because narrowing any of them
would make this a different document from the one the documentation
publishes and the window would stop answering its question: the principal is
a bare STRING rather than a list, the action is `s3:*`, and `Resource` names
the bucket ARN as well as the object ARN.

THAT MEANS THIS DOCUMENT GRANTS THE GRANTEE FULL CONTROL OF THE BUCKET for
the seconds it is live -- object writes, object deletes, and the bucket
policy itself. It is acceptable for exactly one reason: the grantee is our
own credential, in our own estate, and the run has already refused to
proceed unless the ARN below is the one it resolved from that credential.
ANYONE POINTING THIS AT A THIRD PARTY'S ARN IS HANDING THEM THE BUCKET, and
`assert_probe_policy_grants_only` is what stops it happening by edit rather
than by intent.

## _grant_plan

The windows and their builders, in the order they run.

One definition, so the plan `--dry-run` prints is the plan the run sends.
It takes no ARN: each caller applies its own -- the run the one it resolved
from the grantee credential, the dry run `GRANTEE_ARN_PLACEHOLDER` -- and a
parameter here would have been threaded through and then ignored.

The narrow shape goes first: it is the smaller grant, and if the engine
honours semantics at all it is the one that answers the question at the
lower cost.

## assert_probe_policy_grants_only

Refuse a grant probe that could refuse anything, or reach anyone else.

The parallel of `assert_probe_policy_is_reversible`, and separate from it
because the two probe families are safe for opposite reasons. A `Deny` probe
is safe when it names no bucket-resource action; an `Allow` probe is safe
when it is an `Allow` at all, and dangerous when it names the wrong
principal. Sharing one function would mean one set of rules that had to be
weak enough for both, which is how a guard stops guarding.

Four rules, each closing a way this could stop being harmless:

  1. EVERY STATEMENT'S `Effect` IS EXACTLY `Allow`. An `Allow` cannot refuse
     anything, so no document from this mode can lock a bucket -- and that
     has to be a property of the code rather than of the two documents that
     happen to be defined above. A `Deny` refused here is also the brief's
     "no bucket-resource action in a deny" rule, satisfied by there being no
     deny to check.
  2. NO `NotPrincipal`. On AWS semantics an `Allow` with `NotPrincipal`
     grants to every principal EXCEPT the named one, which includes the
     anonymous caller: it would make the bucket world-readable for the life
     of the window. That is the opposite of a scoped grant and it arrives by
     changing one word.
  3. THE PRINCIPAL NAMES THE GRANTEE UNDER `AWS` AND CARRIES NO OTHER KEY.
     No wildcard, no second ARN, no substitute -- and no second principal
     TYPE beside `AWS`. Both routes here read only `Principal["AWS"]`, so a
     `{"AWS": [grantee], "CanonicalUser": "*"}` or `{"AWS": grantee,
     "Service": "*"}` would satisfy the identity check while granting a
     second principal neither route ever looks at. A `*` under `AWS` is
     anonymous public access, which this probe is explicitly not for; a
     different ARN is a grant to somebody who did not consent to it. Checked
     against the ARN the run resolved from the grantee's own credential, so
     a hand-edited document is refused by the same rule as a typo.
  4. EVERY RESOURCE IS THIS BUCKET OR SOMETHING INSIDE IT, AND NONE USES
     `NotResource`. The blast radius of a `Resource` the engine ignores is
     our own key reading our own bucket; the blast radius of a `Resource`
     naming the WRONG bucket is a grant on a bucket nobody was reasoning
     about. `NotResource` is the third inversion beside `NotPrincipal` and
     `NotAction` -- `decide` ignores it, so on an engine that honours it an
     `s3:*` grant would apply to everything EXCEPT the named resource, i.e.
     to `branchleft-tenant-pulumi-state`.
  5. EVERY ACTION IS ONE OF `GRANT_ACTIONS`, AND NONE USES `NotAction`. The
     inversion `NotPrincipal` performs on the noun, `NotAction` performs on
     the verb. The allow-list bounds what a future edit can write rather
     than what window G2 can do -- `s3:*` already subsumes every destructive
     action, and is accepted only because it is the published shape
     verbatim; see `GRANT_ACTIONS`.
  6. THE DOCUMENT'S `Id` IS THIS MODE'S OWN. A grant document under any
     other Id would not be recognised as a leftover by the next run, which
     reads the Id to tell its own probe from a stranger's fence.

Then the whole document goes to `_refuse_an_anonymous_grant`, which asks the
same property as an evaluation question rather than a structural one. Two
independent routes to one invariant is the intent, not redundancy: rules
that were never written catch nothing.

`grantee_arn` is optional only so the shapes can be asserted without a live
credential in a test or a dry run. Rule 3's identity half is skipped when it
is empty -- its wildcard half is not -- and the run itself always passes it.

## _refuse_an_anonymous_grant

The same property asked as an EVALUATION question, not a structural one.

The rules above read elements. This asks `decide` -- the repository's model
of S3 evaluation, and the same function the pre-flight uses to decide
lockout -- who can actually do what under this document. It reaches the
refusals above by a different route, which is the point: a structural rule
that was never written catches nothing, and a shape nobody anticipated then
has two chances to be stopped rather than one. `Principal: "*"` and an
`Allow` carrying `NotPrincipal` both grant the anonymous caller, both are
already refused above, and both are caught again here.

THE ANONYMOUS CALLER IS THE ONLY PRINCIPAL THIS CAN BE ASKED ABOUT, and the
reason is in `decide` itself: its default for any `arn:aws:iam:::user/`
principal is `allow`, because this provider grants every key in a project
access to every bucket in it. So asking about a stranger's ARN returns
`allow` for an empty document as readily as for a hostile one, and a check
built on it would refuse everything. `anonymous` defaults to `deny`, so an
`allow` here can only have come from a statement in this document.

THE RESOURCES ASKED ABOUT ARE CONCRETE, and that is not a detail. `decide`
matches a statement's `Resource` PATTERN against the resource it is given,
so asking about `arn:aws:s3:::<bucket>/*` asks "does this document cover an
object literally named `*`" -- which a statement scoped to `fence-probe/*`
does not, and the check would pass a document that grants the world every
probe object. One real object inside the probe prefix and one outside it
are the two places an exposure lands: the prefix this mode writes to, and
the backups the bucket exists for.

It is a model rather than the live engine, and it is asked about a document
that has not been sent -- so it can refuse, and it can never license.

## _grant_baseline

With no policy on the bucket: the grantee is denied, the operator is not.

TWO FACTS, AND THE RUN NEEDS BOTH, on every probe object rather than on one
of them. The operator's read is the control -- a grantee denial means
nothing if the object is unreadable to everybody, which is what a mistyped
key, a missing object and an unreachable endpoint all look like from the
grantee's side alone. The grantee's denial is the premise: a grant can only
be shown to have granted something to a principal that did not already have
it.

Returns which of the three outcomes this is, rather than a boolean. A
grantee that reads the bucket with nothing on it is a FINDING and the
loudest one this mode can print; a control that failed is a broken run.
Collapsing them into `False` and recovering the difference by reading the
rows back would make the verdict depend on a row's wording.

THIS READ IS ALSO THE ONE A STALE CACHE MOST WANTS TO POISON. It runs right
after this run's own leftover-grant cleanup, when one was found, and a read
path still serving that grant's decision answers `allowed` -- the loudest
wrong verdict this mode can print. So the grantee's read is held by
`_dwell` against `pre_change="allowed"` rather than trusted on the first
attempt, whether or not a leftover was actually found: the operator read
above is a genuine control, this one is also the exact read a stale answer
would poison, and treating it as ordinary would let the poisoning back in.
A `denied` reading needs no holding -- it is the premise this mode is built
on, and nothing stale can manufacture it from a bucket that, moments ago,
may have been granting the same key access.

## _grant_window

One grant window: `(outcome, clean)`.

`outcome` is the grantee's read under the live document when the grant's
withdrawal was verified -- `"allowed"` or `"denied"` -- and `""` otherwise
(a refused PUT, a stored document that is not the one sent, reads that
disagreed, or a withdrawal that could not be confirmed). Each of those is
already a row by the time this returns.

`clean` is whether the bucket is verified to carry no policy afterwards, and
it is a SEPARATE axis from `outcome`. A window can be inconclusive and clean
(G1 rejected outright, bucket untouched) or inconclusive and NOT clean (the
removal failed). The caller runs the next window on the first and stops on
the second, so collapsing the two into one falsy return -- as an earlier
version did -- foreclosed G2 on a clean G1 failure, which is the run where
G2's answer matters most. Cleanliness is read from the policy-removal state,
never from the after-removal grant read: a DELETE that succeeded leaves no
policy on the bucket whatever the grantee then reads.

THE READ AFTER THE REMOVAL IS NOT BOOKKEEPING. Without it, a grantee allowed
under the document and a grantee who was going to be allowed anyway are the
same observation. It is taken through `_observe`, which sends rather than
reads the outcome cache: the identical read was already made inside the
window, and a cached answer here would report the grant's own result as
proof the grant had been withdrawn.

## probe_foreign_grant precondition

THE STRUCTURAL PRECONDITION, AND THE REASON THIS MODE EXISTS. An owner key
as grantee re-creates the blind spot the earlier diagnostic could not see
past, and it would do it silently: every row below would still print and
the verdict would be about owner keys again, under a heading that says
otherwise.

THE COMPARISON IS OPERATOR-VS-GRANTEE, NOT BUCKET-OWNER-VS-GRANTEE, and it
is sound because the operator IS a bucket-project key -- established, not
assumed. This whole run rests on the operator being able to PUT and DELETE
the bucket's policy, and on Hetzner a key administers a bucket's policy
only from within the bucket's own project. So `operator.account` IS the
bucket's project, and a grantee resolving to it is a grantee in the
bucket's project.

## _read_the_grant

The baseline, then both windows, then the reading drawn from the pair.

Both windows run even when the first one grants. The question is not `does
any grant work` but `which shapes does this engine honour`, and an
implementation that matches its own published template while ignoring
everything else is a finding that changes how every document in this estate
has to be written. Stopping early would answer the easier question.

AND BOTH RUN EVEN WHEN THE FIRST ONE IS INCONCLUSIVE, as long as the bucket
is left clean. G1's PUT being rejected outright (`MalformedPolicy`) or its
stored document not matching what was sent are both outcomes this file's own
runbook anticipates, and both leave the bucket carrying no policy -- so
foreclosing G2, which is the provider's documented shape and the one the
architecture question turns on, would answer nothing on exactly the runs
that most need G2's answer. Only a window that leaves the bucket NOT verified
clean -- a removal that failed, a PUT whose fate is unknown -- stops the run,
because layering G2 onto a bucket that may still carry G1's grant is the one
thing that is unsafe rather than merely inconclusive.

## _grant_row

One window's contribution, stated as what it observed.

PASS means the grant reached the grantee. It is not a verdict about the
estate -- a grant that works is good news for a per-tenant architecture and
says nothing about the fence -- and the reading below is drawn from both
rows together.

THE REASON STATES THE OUTCOME RATHER THAN NAMING A DENIAL, and the status is
three-valued for the same reason. `allowed` is a grant reaching the grantee;
`denied` is a shape the engine evaluated and did not honour -- a real FAIL
against the "a fence is buildable" world. Anything else -- an `error` that
`_confirmed_reads` returned because two errors agreed, or the empty string a
window left clean but inconclusive returns -- is neither, and calling it FAIL
"the grantee was still denied" would print a denial that never happened into
the block the runbook tells an operator to paste onto the issue. That is the
substitution `classify`'s docstring says this file exists to prevent.

## read_credentials

The credentials for each role, from the environment and nowhere else.

`require_all` is relaxed only by `--show-account`, which answers a question
about one credential at a time and writes nothing. `needed` narrows which
roles a mode insists on: a verdict about a FENCE is a statement about which
credentials it separates and needs all three, while the engine diagnostic
reaches no verdict about a fence and asks its question with two. Demanding a
credential a mode never sends is an argument an operator has to find, and
every one of those is a chance to paste the wrong value.

The distinct-key check covers the roles this mode uses and no others. An
environment left over from a different mode may well carry a role this one
never signs as, and refusing the run because two credentials it will not
both send happen to be one key would be a refusal about nothing.

## apply_fence

Pre-flight and the double PUT, in one process.

Split across two commands these are two decisions an operator makes
separately, with scroll-back and two credential blocks in between, and the
riskier bucket was the one whose apply had no in-process guard at all --
`configure_backup_bucket.py` covers the backup bucket and nothing covered
the state bucket. Here the PUT is unreachable unless the pre-flight passed.

THE SECOND PUT IS ONLY A CONTROL ONCE THE DWELL HAS RUN. Sent right after
the first, it is authorised against the same cached pre-PUT decision the
first PUT was, and returns 2xx whether the exemption held or the operator
has already lost `PutBucketPolicy` -- the exact failure mode
`configure_backup_bucket.py` had, on the bucket that holds every tenant's
Pulumi state. `_await_policy_settle` is what makes the second PUT mean
anything, and by the time it returns, `dwell_seconds` has elapsed since the
fence was actually written -- which is also why the plain verify mode this
`--apply` run is normally followed by (steps 1f/2d) does not need a dwell
of its own: it never reads sooner than this one already waited.

## report

`rows` are `(name, status, reason, note, critical)`.

`clean_message` replaces the closing line for a mode whose clean run is not
a statement about a policy. Without it, `--show-account` would end by
saying the policy is safe to apply, having read no policy at all.

`banner` replaces the shout raised by a failed critical row, for the same
reason: `--probe-notprincipal` writes no fence, so neither "the bucket may
be locked" nor "re-render it against the account id printed above" is a
true sentence about what just happened there.
