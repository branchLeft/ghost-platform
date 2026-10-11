# app.ts

## route tables

`LITERAL_ROUTES` (every exact `(method, path)` pair except
`GET /status/{slot}`) and `STATUS_ROUTE` (that one parameterised route, kept
separate because a path parameter cannot be expressed as a plain literal
match) are read straight off the route table the generated server package
carries (`generated/routes.gen.ts`), not written out by hand.
`test/unit/openapiConformance.test.ts` reads both constants and checks them,
in both directions, against `openapi.yaml`'s own paths and methods. Because
the table is generated, that test now also catches a committed generated
tree that was not regenerated after the spec changed.

## generated server

`openapi.yaml` is the contract. `speckify.yaml` (repository root) names the
packages generated from it, and `.github/workflows/speckify.yml` publishes
them to GitHub Packages on a merge to main. The broker does not install that
published package: it compiles the same generated sources, committed under
`src/generated/`, with one `// @ts-nocheck` header added to each file. They
are committed, not generated at build time, for three reasons: the broker's
own CI must not depend on a registry round trip for the package its own spec
change produces; the live-proof harness mounts only `dist/` into a container,
so the client has to compile into it with relative imports; and a build-time
`speckify build` would put a network fetch of the last published version
inside every test run. The header is there because the broker's compiler
options (unused locals, no DOM library) are stricter than the package's own.

`scripts/assert-broker-contract-generated.py` is the guard that the committed
tree is exactly what Speckify generates: `speckify.yml` runs it on every pull
request and again before a publish. To regenerate after editing the spec:

```sh
speckify build
python3 scripts/assert-broker-contract-generated.py --write \
  .speckify/out/broker-api/typescript/src
```

`createBrokerHandler` is a thin front door around the listener the generated
server builds, and `createHandlers` is the generated `Handlers` interface
implemented: one method per operation, each returning only a status and body
that operation's `responses` declare, which the compiler checks. Three things
stay hand-written because the generated adapter does not do them as the
contract says:

- **Routing.** The adapter matches an empty path segment (`/reconcile/`,
  `//reconcile`) and throws on a bad percent-escape. `matchRoute` matches
  whole segments against the generated route table first, so those are the
  plain 404 they always were. An enumerated-slot check on `/status/{slot}`
  and a declared-length check for JSON bodies also answer here, with no body.
- **The gate** (`createGate`, passed to the adapter as `beforeHandle`). The
  signature is verified over the raw body first (401, no body); only then is
  the body parsed (400), its `slot` checked (422) and the spec's own request
  schema applied (400 `{ error }`). The adapter would answer the last three
  itself as `application/problem+json` with status 400, which is not what the
  spec declares. `beforeHandle` can refuse only by throwing, which the adapter
  turns into a 500, so the gate writes its answer straight onto the response
  (kept in a `WeakMap` by the front door) and throws `RefusalSent`.
- **Streaming and signing for `/image`.** The signature covers a manifest of
  two header values, never the body, so it is checked in the gate before a
  byte of the image is read (`readImageHeaders`, `authenticateImagePush`),
  and the handler streams the body to disk (`receiveImage`). The generated
  client cannot stream or sign, so `controlPlanePush.ts` supplies the stream
  and the signature itself.

What is and is not checked at run time: request bodies are validated against
the spec's schemas (in the gate); `200` bodies are validated against the
spec's schemas by the adapter. Error bodies are typed by the compiler but not
validated at run time.

Known differences from the hand-written router it replaced, all in states
that were already outside the contract: a signed JSON `null` body is a 422
(it was a 500); a `/reconcile` for a slot already `running` with no recorded
colour is a 409 occupied (it answered 200 with no colour, which the
`SlotColourPhase` schema refuses); a chunked body over the cap that declares
no length is refused 413 by the adapter with a problem document as the body
(the status is the same).

## attemptColourSwap

Deploys a new descriptor into a slot already `running` one colour, into the
*other* colour, live, with the first colour still serving throughout. Called
only once the caller has confirmed `state.phase === 'running'` and
`state.colour` is set; holds the same per-slot lock `handleReconcile` already
claimed, and resolves to the response itself so its caller can simply
`return` whatever this resolves to.

**Never calls `deps.wrapper.reset()`.** That is the one thing this function
must not do that a fresh deploy's own retry path does on failure: `reset`
stops and wipes *both* colours, and `state.colour` — the one already running
— is still genuinely serving readers for the entire duration of a swap
attempt. Draining is not stopping: this protects the old colour just as much
during a failed promotion as during a deliberate rollback, so a swap that
cannot complete leaves the slot exactly as it found it, never as an outage.

`swapTarget` is recorded before any other side effect, mirroring the
fresh-deploy path's own `preparing` write: a crash partway through this
function is otherwise invisible to `recoverCrashedSlots` — the persisted
phase would stay `running`/`liveColour` for the swap's whole duration, so a
retried `/reconcile` after such a crash would believe `liveColour` is still
live and could drain the colour the crash actually left serving.
`swapTarget` plus the new descriptor's own hash/hashId are what let
`recoverSwapInFlight` (`stateStore.ts`) tell "a swap into `target` was in
flight" apart from "this slot is quietly running", and adopt the right
colour with the right hash if it finds `target` already safely live.

## attemptColourSwap traffic move

The colours alternate, so the order in the edge's static upstream list can
never encode "prefer the newer one" — what makes the swap work in both
directions is that a new colour always boots drained, combined with Caddy's
`lb_policy first` preferring the first-listed, healthy upstream:

- Deploying into the first-listed colour (`a`): clearing its flag is already
  the one flag change that moves everything — it is healthy and first, so
  nothing further runs here.
- Deploying into the second-listed colour (`b`): clearing its flag moved
  nothing, because `a` is still healthy and still preferred. Only draining
  `a` moves traffic — which is exactly why the refusal check guards this
  branch and no other.

## attemptStopOldColour

Stops the colour a completed swap left running, drained, for the whole bake
window. Called only once the caller has confirmed `state.phase === 'running'`,
`state.colour` is set and `state.trafficBaseline` is set — the last of those
is what distinguishes "this tenancy arrived by a swap, so there is an old
colour to stop" from a fresh deploy's own `running`, which has none. Holds
the same per-slot lock `handleStop`'s caller already claimed.

Three independent checks guard the one irreversible side effect, each
refusing rather than guessing, in the order that costs least first:

1. The new colour must have *served real traffic*, not merely reported
   healthy. `deps.realTraffic` is the one signal in the estate that actually
   observes an admitted reader request (`services/demo-gate`'s counter);
   refused until a fresh reading exceeds the baseline `attemptColourSwap`
   recorded.
2. No email or batch may be `submitting` — stopping mid-send is what turns
   Ghost's own anti-duplicate rule into a reader getting a partial
   newsletter.
3. Immediately before the one irreversible side effect, the survivor must
   still be undrained and healthy right now. This mirrors
   `attemptColourSwap`'s own second, independent readiness check: no step
   may ever leave a tenant with no colour serving, and neither check above
   says anything about the survivor's own current health.
