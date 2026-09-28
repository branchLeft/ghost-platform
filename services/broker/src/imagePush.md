# imagePush.ts

## POST /image

`POST /image` is the host side of the image-push design: the control plane
pushes each new image over the connection it already dials into this host
with — the same signed, inbound-only link `/reconcile` and `/reset` use —
rather than the host ever pulling from a registry. This module is the one
place that receives a pushed image and decides whether to trust it;
`plugins/dockerImageLoader.ts` is the one place that then loads it, and is
the only file in this service that ever invokes the privileged sudoers
wrapper for `load` — an audit for "does anything here ever `pull`, or hold
the Docker socket directly" has exactly one file to read, and it is not
this one.

Every push is staged at the same fixed path, `join(deps.tmpDir,
IMAGE_STAGING_FILENAME)` — never a per-request random name. The `load` verb
is sudoers-enumerated the same wildcard-free way `start`/`stop`/`reset` are
(`demo-host/provision/render_slot_sudoers.py`), which is only possible
against a literal, unchanging argument; a `mkdtemp`-named path would need a
wildcard to authorise, which is the exact argument-injection shape this
design refuses everywhere else. One fixed path means at most one push is
ever in flight at a time, which `pushInFlight` enforces rather than leaving
two concurrent uploads to corrupt each other's bytes on the same file.
