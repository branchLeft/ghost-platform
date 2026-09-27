# The live-proof origin: same base and same vendored bundles as
# widgets/origin/Dockerfile (self-hosted Portal etc., so the strict policy's
# script-src has nothing but our own origin to allow), with this story's
# Caddyfile instead -- the header this story's proof needs, on top of an
# otherwise identical origin.
FROM caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

COPY csp/proof/Caddyfile /etc/caddy/Caddyfile
COPY widgets/dist/ /srv/bl-assets/
