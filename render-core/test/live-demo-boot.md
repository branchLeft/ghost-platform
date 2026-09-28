# live-demo-boot.test.ts

## The live boot control

The real control this suite provides: a rendered demo does not merely write
seven files — it runs. Renders the demo golden fixture's own `compose.yml`
(the actual `render()` output, not a hand-written stand-in), provisions its
three external volumes exactly as the eventual demo-host build step would,
starts `ghost-a` for real against the platform image, and asserts Ghost
answers on loopback while never publishing on the private-IP-shaped address
a demo's own `appHostIp` field carries.

Needs Docker and the `ghost-platform:ci` image (built by this repo's
`docker build .` at the repo root — see `build.yml`'s "docker build" job,
which already builds and smoke-tests it on every PR). `render-core-ci.yml`
runs `npm ci`/test/coverage inside `render-core/` only and never builds that
image, so this suite detects its absence and skips rather than failing a CI
job that has no way to produce it — proven locally, where both
preconditions hold.
