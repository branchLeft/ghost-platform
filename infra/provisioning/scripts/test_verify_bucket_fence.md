# test_verify_bucket_fence.py

## Module overview

Tests for the fence verifier, built around the mistake that produced it.

The historical failure was recording one `AccessDenied` as proof that a
credential was scoped to one bucket, when the denial was in fact a project
boundary and the credential was scoped to nothing. Every test here that matters
is a variation on that: a denial arriving for the wrong reason must never come
out of this file as a pass.

There is a second mistake recorded here, and it belongs to this file. Every
object-read test once fed the classifier a hand-written
`An error occurred (AccessDenied)` stderr, which is the shape the `aws` CLI
renders for most commands -- but not for anything against this endpoint, whose
storage engine returns error documents the CLI cannot render at all. The suite
passed while the probes it covered could not reach a verdict. So responses here
are not "the real shapes" on assertion: each fixture states whether it was
observed on the wire or written, and `TestFixtureProvenance` refuses an
unlabelled one.

## Response

One HTTP response, with where it came from attached.

`source` opens with `observed:` or `constructed:` and nothing else. A
fixture observed on the wire constrains the code; one written here
constrains only what its author expected, and a probe covered by a fixture
nobody checked against the wire can be green and unable to reach a verdict.

Every instance registers itself, for the body checks in `tearDownModule`
that need the actual bytes. The label check is static -- see
`_fixture_labels` for why a registry cannot answer it.

## Baseline reads

Eight baseline reads (four windows' probe objects, both roles) with
no dwell of their own. Each window's `pre_change` is the PRIOR
window's own settled reading, not a hardcoded "allowed" -- so only
window B is still moving away from the no-policy baseline. Under a
per-key engine: window B's subject (denied) and operator (allowed)
both differ from that baseline and count at once; window B's
operator answer of `allowed` is held. Window C moves away from
window B's readings -- its subject (allowed, vs B's `denied`) and
operator (denied, vs B's `allowed`) both differ and count at once.
Window D moves away from window C's readings -- its operator
(allowed, vs C's `denied`) differs and counts at once, but its
subject (allowed) matches C's subject (also `allowed`) and is held
for the full dwell before it counts.

## Window A fixture

WINDOW A IS THE ONE WINDOW NO FIXTURE ABOVE FORCES. Every engine in
`WORLDS` that reaches window A also happens to leave window D's
operator reading at "allowed" -- the same value the pre-fix
hardcoded fallback would supply -- so a read-count assertion built
from one of those engines cannot tell threaded `pre_change` apart
from a dropped one at this call site specifically. This drives
`_read_the_engine` directly, with `_window` mocked to return a
scripted reading per window and record what it was called with, so
the property under test is the `pre_change` argument itself: window
D's operator reading is "denied" here, and only a caller that
actually threads window D's own settled reading forward passes that
to window A rather than the "allowed" every role defaults to.

## Grant engines

THE GRANT ENGINES. Each is one coherent answer to "what does an `Allow`
naming a principal in ANOTHER project do here", written as the rule that
decides a single read. They exist for the same reason the deny engines do: a
probe that reports the same thing in a world where grants work and a world
where they do not is worth nothing, and the only way to know it does not is to
run it in both and compare.

`key` is the access key the read was signed with, `statement` the one statement
the live policy carries, and `object_arn` the object being read -- an engine
evaluates `Resource` against the object, so a rule that could not see it would
be answering a different question from the one the engine is asked.

Every rule returns whether the read is GRANTED. That is the inverse of the deny
family's convention, and deliberately so: these documents are Allow-only, and
a rule phrased as "does this refuse" would have to double-negate in every line.

## Guard job is not the control

GUARD-JOB-IS-NOT-THE-CONTROL. Mutation testing tried 26 mutations of this
function; the one that survived replaced the `_refuse_an_anonymous_grant(...)` call
with `pass`: all tests stayed green, because the six direct tests
exercise the inner function and nothing asserted the composed guard
still calls it.

A "the composed guard refuses an anonymous document" test would NOT
catch that mutation: every anonymous-granting shape (`*`, NotPrincipal)
is already refused by a STRUCTURAL rule, so such a document is refused
with or without the call. The evaluation route is a semantic backstop
for a future weakening of those rules, and the only way to pin its
wiring is to assert the call itself happens.

## fixture-labels

Every `Response(...)` in this file, read from its source.

Static rather than runtime, because a runtime registry only ever holds the
fixtures constructed so far: `unittest` runs classes in alphabetical order,
so a registry inspected from a test class sees nothing built by the classes
that sort after it, and `Response.every` starts empty in every process.
Roughly half the fixtures here are built inside test methods.

A label has to be resolvable from the source -- a literal, a module
constant, or a concatenation of those. One computed at run time cannot be
checked here and is refused on that basis.
