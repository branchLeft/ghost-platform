# verdict-client.js

## FakeVerdictClient

Classification vocabulary for the hash route: `csam` | `harmful-abusive-
material` | `test` | `no-known-match`, plus `unavailable` from the Check
interface itself when no verdict could be reached.

This fake is still in-process, but it can simulate the channel the hold
branch depends on: a digest named in `unavailable` answers `unavailable` —
not by hanging (`checks.js`'s own timeout already proves that race;
duplicating it here would only make every test slower) — until it is told
the real answer, in one of two ways.

`deliverVerdict` resolves it in-process, for a unit test in the same process
as the adapter. `resolvePath`, an optional directory, is for the image-test
harness: a container and its test driver are two different processes, so the
driver "delivers" a verdict by writing `<resolvePath>/<digest>.json` (via
`docker exec`) and this client picks it up on its next poll. Nothing about
the real verdict channel's wire format is implied by a JSON file on disk —
this is purely a test seam.
