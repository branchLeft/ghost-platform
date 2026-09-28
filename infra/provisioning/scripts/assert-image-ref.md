# assert-image-ref.py

## Module overview

Refuse a tenant `image_ref` that is not a digest-pinned image in this org's
GitHub Container Registry namespace.

The app host resolves this reference at deploy time, not the runner
(`infra/tenant/index.ts`'s `imageEnvPath`), so a reference the runner accepts
but the host cannot pull provisions an entire tenant before failing.

The value also reaches a systemd `EnvironmentFile` by way of
`pulumi config set imageRef`, so it is parsed as a whole-string grammar rather
than by prefix and suffix: anything permitted between them is injected into the
unit's environment, one `KEY=VALUE` per newline.
