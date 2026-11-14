# publish-job-checks.mjs

The shape checks for an image publish workflow built the way
`drain-sidecar-image.yml` is: a `build` job that proves the image and saves it,
and a `push` job that loads exactly that image and publishes it. It has one home
on purpose; it used to live inside `workflow-drain-sidecar-publish.test.js`, and
`workflow-demo-edge-image.test.js` needed the same checks, and so does
`workflow-demo-gate-image.test.js`, the third consumer.

`problems(source)` returns the list of ways the workflow text departs from the
route: a write scope at the top level or in any job but `push` and `attest` (the
signing job, which runs after the scan); a `push` job with
no job-level guard that is exactly the main-only expression (`GUARD`), that does
not wait on `build`, that rebuilds, that does not consume the proof job's image
ID or load it, that never pushes, that does not refuse a malformed digest, that
does not output the pinned reference, or that tags `latest`; and a `build` job
that does not save the image and output its ID. `parseJobs(source)` splits the
jobs out by indentation so a step-level `if:` is never mistaken for a job's own.

Comments are stripped before matching, so text in a comment cannot satisfy a
check. The `push` job is also scanned unstripped for a rebuild, so a `#` inside a
shell body cannot hide one.

Node built-ins only; no install.
