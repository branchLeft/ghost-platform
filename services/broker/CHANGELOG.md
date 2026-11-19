# Changelog

All notable changes to the broker release bundle (`broker-vX.Y.Z`, built from
`services/broker`) are recorded here.

## 0.2.0

**The broker can freeze a slot's evidence and push images to a host.**

- **Additive:** `POST /freeze` is the only writer of the held-evidence marker.
  It records the slot `detaching` with evidence `frozen` before any side
  effect, revokes the slot's lease, gate hash, drain flags and Ghost access
  key, then runs the new sudoers-wrapped `detach` verb, which moves the slot's
  whole held set into the held area, seals, hashes and verifies it. Only a
  receipt that parses and names the slot records evidence `detached` and moves
  the slot to `error`, which is what lets a later `POST /reset` through. It is
  idempotent and resumes a slot left `detaching`. A 503 leaves the slot
  `detaching`, so every reset stays refused until a freeze completes.
- **Additive:** `POST /reset` answers a 409 with a `reason` (`locked` or
  `held-evidence`) so a caller tells "retry later" from "never retry, page"
  without reading the message. `GET /status` carries an `evidence` field
  (`absent`, `frozen` or `detached`); a client that validates the response
  against the old schema must accept it.
- **Additive:** control-plane call sites push the demo drain sidecar image,
  the demo slot Ghost image and a pinned-by-digest image to a host, as
  `controlPlaneSidecarPush`, `controlPlaneSlotImagePush` and
  `controlPlaneImagePush`, each with a command-line entry point.
- **Additive:** the descriptor's `mail` spec accepts an optional `route`
  (`{ primary: "mx1" | "sweego", sweegoAllowance?: integer }`), carried on the
  collector's drain target. Absent means `mx1`. The pairing rules stay in the
  render core's validator.
- **Additive:** the signed-request check is one function, `checkRequest`,
  that returns a fixed refusal code, and `signedRequestScheme` exports what
  another process may bundle. The verdict host builds its check from it
  instead of a hand-written port. The broker's own answers and the wire
  scheme are unchanged.
- **Fixed:** an image push whose deadline fires during the response body read
  is thrown as the deadline error, not reported as a status that never
  arrived.
- **Fixed:** an image push whose 2xx body cannot be read or parsed is thrown,
  not reported `ok: true`, because the receiver may or may not have loaded the
  image. A 3xx is now a refusal and is no longer followed.
- **Fixed:** `GET /status` names the live colour when it asks the slot's
  health router, so `healthy` describes the running colour and never the idle
  one.
- **Changed:** the default slot health port base is 10100, not 9100, which
  node_exporter holds. A host that sets `BROKER_HEALTH_PORT_BASE` is
  unaffected.
- **Changed:** the unit may write `/var/lib/docker/volumes` (the slot reset
  empties tenant volumes there), and `BROKER_WRAPPER_DETACH_TIMEOUT_MS`
  (default 600000, at most 3600000) bounds `detach`, which hashes a whole
  tenancy.
- **Changed:** the bundle builds against the published
  `@branchleft/ghost-platform-render-core` 0.4.0 instead of a local link.
- **Docs:** `RUNBOOK-broker-deploy.md` creates `broker.env` only when absent,
  pins the first-boot commit, and names the platform zone in the env template.

## 0.1.0

The first release: the reconcile, reset, status and drain endpoints, the
sudoers-wrapped slot wrapper as the only path to root, and the signed-request
scheme in front of every side effect, packed as a signed, attested bundle.
