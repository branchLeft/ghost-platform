# The proof-of-concept origin for branchLeft/workspace#1230: serves the
# pinned widget bundles (widgets/dist/, content-addressed against
# widgets/pins.json) and reverse-proxies everything else to the Ghost
# container, so both are the same origin to a reader's browser. See
# widgets/README.md for why this exists and why it is not the production
# edge.
#
# Pinned by digest, like the Ghost image itself, so a rebuild is
# reproducible and a base-image swap is a visible, reviewed diff.
FROM caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

COPY widgets/origin/Caddyfile /etc/caddy/Caddyfile
COPY widgets/dist/ /srv/bl-assets/
COPY widgets/proof/signup-embed.html /srv/proof/signup-embed.html
