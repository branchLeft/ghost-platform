# provision-owner.mjs

## Overview

A freshly started Ghost has no owner, and its setup route creates one for
whoever calls first. This creates the real owner from the app host before the
tenant's hostname is served, so the setup page is never the way in. The edge
also refuses the route for every hostname (`hetzner/edge/render.md` in
`shared-infra`), but that is the second lock, not this one.

```sh
node provision-owner.mjs --container <name> --email <address> --name <owner name> \
  --site-url <https url> --site-title <title>
```

## Flow

1. Reads Ghost's setup status from inside the container. A Ghost that already
   has an owner is left untouched and reported as `alreadySetUp`, but only if
   that owner's email matches `--email` (case aside). A different owner means
   someone else claimed it first, so the script refuses with
   `OwnerProvisionRefusedError` rather than reporting success. A second run
   never sends a second link or changes anything.
2. Creates the owner through Ghost's own setup route, with a password
   generated inside the container and dropped. It is never printed, logged,
   or placed in argv or env, so no one holds it.
3. Asks Ghost to email the owner a password-reset link. That link is how the
   owner first signs in and chooses a password: the owner receives a link,
   never a password.

Ghost's own setup route is used rather than writing rows, so the owner is
exactly what Ghost makes: role, slug, settings and the first-run state.

Requests go to Ghost on its loopback listener inside the container, with the
site's `Host`, `Origin` and `X-Forwarded-Proto: https`, because Ghost
redirects or rejects a request that does not look like its configured URL.

## Result

One JSON line: `{created, alreadySetUp, linkRequested?}`. Ghost refusing a
step throws `OwnerProvisionRefusedError` with the status it answered.

## Order of use

Run it after the container is healthy and before the hostname is added to the
edge's registry, so the site is never reachable while it has no owner. If the
sign-in email cannot be delivered the owner exists and the link request can be
repeated by the owner on Ghost's own sign-in page.
