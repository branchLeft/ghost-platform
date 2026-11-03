# Ghost core overlay: models/settings.js (Stripe connect limit)

A demo slot must not connect a real Stripe account. Ghost's own `limitStripeConnect` host limit guards only the
Connect-token edit, so this overlay makes the settings model enforce the same limit on every write path. The
only Ghost-core file it patches is `core/server/models/settings.js`. **No copy of Ghost's source is committed
here.** The baseline is the file already inside the digest-pinned Ghost image the root `Dockerfile` builds on,
so a Ghost release reaches us through that image bump, never hidden behind a stale copy. What is committed is
our change only:

| File | What it is |
|---|---|
| `stripe-connect-limit.patch` | The unified diff of our one change, against Ghost's file. |
| `stripe-connect-limit.patched.sha256` | The SHA-256 of Ghost's file with the patch applied. |
| `stripe-connect-limit.md` | What the patched function does and why. |

The script that applies it is the generic `adapters/ghost-core-overlay/apply-patch.sh`.

## Scope

Demo slots only. The limit is on when render-core renders
`hostSettings__limits__limitStripeConnect__disabled: true`, which it does for `kind === 'demo'` and for nothing
else. A paying tenant keeps Ghost's standard Stripe behaviour, and the patch is inert for it. Paid tiers stay
visible on a demo; only connecting a real account is refused.

Known residual: Ghost's Connect start route still redirects to Stripe's own page, but every write that would
store the result is refused.

## How the image build uses it

The root `Dockerfile` runs `apply-patch.sh` on Ghost's file in the base image, in one layer: `patch` is installed,
used and removed there, and its output is hash-checked. The build **fails** in two distinct ways:

- `stripe-connect-limit.patch no longer applies cleanly`: a Ghost bump changed lines the patch touches.
- `does not match stripe-connect-limit.patched.sha256`: the patch applied, but the result is not the file the
  pin was taken from, so Ghost changed the file somewhere the patch does not look.

Either way re-deriving is a deliberate step (below), not automatic.

## Rollout order

The overlay is inert without the key, and the key is only partial protection without the overlay. So: promote the
rebuilt image to the demo host first; only then publish the render-core release carrying the key and roll the
broker onto it. Never render the key onto an image that lacks the overlay.

## How it is tested

`test/image/stripe-refusal.image.test.mjs` (see its `.md`), run in the required `docker build` job against the
built image, with a paired control that has the same image and environment minus the limit key.

## Re-deriving it on a Ghost upgrade

1. Extract Ghost's new file from the new base image:
   ```sh
   cid=$(docker create ghost:<new-version>-alpine@sha256:<digest>)
   mkdir -p /tmp/a /tmp/b
   docker cp "$cid:/var/lib/ghost/current/core/server/models/settings.js" /tmp/a/settings.js
   docker rm "$cid"
   cp /tmp/a/settings.js /tmp/b/settings.js
   ```
2. Re-apply the same change to `/tmp/b/settings.js` (see `stripe-connect-limit.md`). If Ghost's own validation or
   Stripe handling has changed shape, read the new upstream source rather than assuming the same fix applies.
3. Regenerate the patch with the two paths labelled as the script expects, and copy it over
   `stripe-connect-limit.patch`:
   ```sh
   cd /tmp && diff -u --label a/settings.js --label b/settings.js a/settings.js b/settings.js > stripe-connect-limit.patch
   ```
4. Write the new pin from the patched file, as `<hash>  settings.js` in `stripe-connect-limit.patched.sha256`:
   ```sh
   shasum -a 256 /tmp/b/settings.js
   ```
5. Rebuild the image and run the image test.
