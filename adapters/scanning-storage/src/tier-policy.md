# tier-policy.js

## One key, closed by default

`resolveTierPolicy(config)` turns `storage__<feature>__tier` into
`{ allowVideoAudio: boolean }`, which the entry file hands to the decorator.
Only the exact string `professional` gives `true`. Unset, null, empty, a
different case, a stray space, a boolean, `entry`, `demo`, `hobbyist` and any
typo give `false`. The decorator reads only the boolean `true` as well, so
one constructed without the option refuses video and audio.

The key comes from boot config. It is not read from anything an uploader or a
tenant can write, and it is not inferred from limits, caps or hostnames.
render-core renders no `tier` key for any demo or tenant yet, so today every
rendered configuration refuses video and audio. The remaining slice is a tier
field on the tenant descriptor (a schema version change) and render-core
rendering this key from it.

## What each answer does

- **`false` (every tier but Professional, and any tier that cannot be
  told):** video and audio are refused with a typed 415 before anything is
  hashed, looked up, checked, quarantined, held or written. No verdict is
  asked. The refusal is counted as `reason="video-audio"` (`metrics.md`) and
  logged as `UPLOAD_REFUSED_VIDEO_AUDIO` with the container family and no
  byte content.
- **`true` (Professional):** video and audio are stored as they arrived,
  without the check. No verdict, scanned or clean metric is recorded, and no
  line says the upload was scanned. The control for this tier is the owner's
  due diligence and manual check-ins, by his ruling of 24 September 2026; it
  is not in this adapter.

Anything that is not video or audio (`media-kind.md`) goes to the existing
check whatever the tier.

## Holds

A hold is only ever created from the check's `hold` outcome, which a refused
or Professional video or audio upload never reaches, so a hold created by
this code never carries video or audio. Resuming a hold after a restart
re-asks the verdict and promotes; it does not classify the bytes again. A hold
written by an earlier version of this adapter, from before the kind gate,
would therefore be promoted on a clean verdict whatever its kind. With no
verdict source rendered for any tenant, no such hold can exist in a rendered
deployment today.
