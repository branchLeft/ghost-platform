# refusal-error.js

## Refusal wording

The wording is decided by two things: the audience reading it and the
classification. `buildRefusalError(GhostErrors, verdict, audience)` takes
`audience` from `AUDIENCE`:

- `TENANT_STAFF` gets the specific message (naming the classification) for
  an ordinary match. Every upload is made by authenticated tenant staff, so
  the scanning path passes this audience.
- `ANONYMOUS` gets the neutral `GENERIC_CONTEXT` for every match. It names no
  classifier.
- Any other or missing audience gets the neutral message. The wording fails
  closed rather than guessing who is reading it.

For `csam` (tier two), the message is `GENERIC_CONTEXT` for every audience,
tenant staff included. The specific reason is operational intelligence, and
an authenticated account can be a compromised one. The control case is that a
tier-two match through the tenant-staff path still returns the generic
message; the unit tests in `test/unit/refusal-error.test.mjs` prove it, and a
sabotage that removes the exception turns them red.

## Video and audio refusal

`buildVideoAudioRefusedError` is a typed `UnsupportedMediaTypeError`
(415) for video or audio on a tier that does not accept them. Nothing was
hashed or checked, so it names no classification. Its message and context
are the placeholders `VIDEO_AUDIO_REFUSED_MESSAGE` and
`VIDEO_AUDIO_REFUSED_CONTEXT`; the owner supplies the real wording.

## Upload-name table errors

`buildNamesFullError` and `buildNameLapsedError` are typed `MaintenanceError`
(503) for the adapter's promised-name table being full, and for a `save()` of
a file whose promised name lapsed. Neither judges the bytes, and the import
can be run again, so neither is a 415.
