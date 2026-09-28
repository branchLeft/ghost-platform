# bucketpolicy.py

## Module overview

Hetzner has no IAM. Its documented default is that each key pair is valid for
every bucket in the same project, so an S3 `Allow` narrows nothing and a
bucket-policy `Deny` is the only mechanism that fences a bucket at all. Two
generators build one — `render-media-bucket-policy.py` for a tenant's media
bucket, `render-bucket-fence-policy.py` for an operational bucket — and they
share this module rather than each carrying a copy of the principal syntax and
the evaluation model. A divergence between the two would be a boundary that is
correct in one generator and not the other, with nothing to reveal which.

Principal syntax is Hetzner's, not AWS's: `arn:aws:iam:::user/p<project>:<key>`
— three empty colon-separated fields, and a `p` prefix on the project id.

`decide()` is a MODEL of S3 policy evaluation, not Hetzner's implementation.
Hetzner documents `NotPrincipal` verbatim but publishes no list of supported
Actions, Principal formats or Conditions. Nothing computed here is evidence
about a live bucket; only the probes in `verify-bucket-fence.py` are.

`NotAction` is the exception, because it is no longer unknown. This engine does
not implement it: a statement carrying `NotAction` is accepted, stored, and
returned by `get-bucket-policy` byte-identical to what was sent, and enforces
nothing. The model below therefore skips such a statement rather than
evaluating it, and `assert_enforceable()` refuses to emit one at all — a
policy that cannot be modelled honestly must not be written to a bucket.

## RECOVERY_ACTIONS

What each role must still be able to do once a fence is applied. These are
the questions `decide()` is asked before a policy is written, by the renderer
on its way out and by `verify-bucket-fence.py`'s pre-flight on its way in.

Whether a credential is locked out is an EVALUATION question, and only
`decide()` answers it. A structural scan of `NotPrincipal` lists cannot: a
fence deliberately contains Deny statements that name only the operator —
`DenyObjectMutationsExceptOperator` withholds the version-destroying actions
from the workload on purpose — so "this Deny does not name the workload" is
what a working fence looks like, not a lockout.

## BUCKET_CONFIGURATION_ACTIONS

Every bucket-resource action that reads or rewrites the fence itself, plus
the version listing, which is a read but enumerates earlier object versions.

Enumerated, and that is a REGRESSION accepted rather than a design choice.
The `NotAction` form these lists replace made an action nobody thought of
fall closed; a denylist makes it fall open, back to Hetzner's project-wide
default.

Breadth is not free, which is where the first version of this went wrong.
It reasoned that listing an action the platform does not support costs "a
longer array", so the lists should be padded against the day support lands.
That is false on this engine: an action name its policy parser does not know
does not sit inert in the document, it makes the WHOLE document
unacceptable. The bucket then keeps whatever policy it had, and the failure
arrives as an HTTP 503 with an empty message during a live apply — which
the AWS CLI cannot render at all. Nineteen padded names were rejected that
way. `PARSER_REJECTS` below is that measurement, kept so the reasoning
cannot quietly come back.

So these lists are exactly as wide as the parser's vocabulary and no wider,
and adding a name to them is a live question, not a judgement call.

## PARSER_REJECTS

Action names this engine's policy parser REFUSES. Measured against a live
bucket, one name at a time, each in an otherwise known-good document: 19 of
81 rejected, every one a name added speculatively rather than because
something needed it.

Kept as data rather than deleted, for two reasons. It is the only record
that these were tried, so nobody re-adds them on the same "costs nothing"
reasoning; and `test_no_emitted_action_is_one_the_parser_refuses` asserts
the emitted lists stay disjoint from it, which turns a re-add into a red
test instead of a 503 in the middle of an operator's live apply.

This is a measurement of one engine at one time, not a specification. If
Hetzner ships support for any of these, the way to find out is to probe the
live endpoint again — never to assume a name parses because AWS documents
it. Every one of these is documented by AWS.

## assert_enforceable

Refuse a policy whose enforcement this engine will silently decline.

A `NotAction` statement is accepted by `put-bucket-policy`, stored, and
returned by `get-bucket-policy` byte-identical to what was sent — so a
round-trip comparison, which is the check both runbooks perform, passes on
a statement that enforces nothing. The failure is visible only to a live
probe under a credential the statement is supposed to stop, and only in the
permissive direction, which is the direction nobody looks.

Called by both generators on the way out, so the shape cannot reach a
bucket regardless of which one wrote it.
