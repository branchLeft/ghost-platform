# test_objectstorage.py

## KnownAnswerTests

Cross-checks `build_headers` against a second, independently written SigV4
implementation rather than a single hardcoded magic value.

A worked example copied from a secondary source turned out to be an
unreliable fixture in practice here: two separate lookups of AWS's
published "PUT Object" example returned mutually contradictory signatures
and a header set that mixed the GET and PUT examples together, which
would have made a wrong value indistinguishable from a real regression.
Re-deriving the algorithm from AWS's canonical spec prose
(<https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html>)
as a standalone function, then requiring it to agree with `build_headers`
across a fixed case and several randomised ones, catches the same class
of systematic error -- wrong key-derivation order, wrong canonical-request
field order, wrong URI/query encoding -- without depending on a
transcription this file cannot independently verify.
