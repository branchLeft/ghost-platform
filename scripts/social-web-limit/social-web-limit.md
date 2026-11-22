# social-web-limit.image.test.ts

render-core locks the social web (ActivityPub) feature only as rendered output:
`hostSettings__limits__limitSocialWeb__disabled: true` for every kind of tenant
(`render-core/src/environment.md`, `render-core/test/environment.test.ts`). This
test shows the lock works in a booted Ghost from the built image.

Run: `IMAGE=ghost-platform:ci node --test scripts/social-web-limit/social-web-limit.image.test.ts`.
Needs Node 22.18 or later (it runs the TypeScript directly) and no install: the
Docker helpers are the export-bundler image test's, shared with its other users.
`TENANT_COMPOSE_GOLDEN` names another Compose file to read the environment from.
It runs in the `docker build` job of `build.yml`.

## What it reads

The `hostSettings__*` lines of `render-core/test/golden/entry-tenant.compose.yml`
(first colour block) become the container's environment. A line the render does
not carry is absent from the container too.

Two reads per Ghost, both through the admin API as the owner:

- `/ghost/api/admin/config/`: `config.hostSettings.limits.limitSocialWeb.disabled`,
  the object the admin's own limiter reads (the call `widgets/proof/capture-network.mjs`
  makes for `signupForm`).
- `/ghost/api/admin/settings/`: `social_web` (the setting) and `social_web_enabled`
  (calculated). The sidebar's Network item renders only when `social_web_enabled`
  is true (`apps/admin/src/layout/app-sidebar/nav-main.tsx`), and Ghost computes it
  true only when `social_web` is on, the site is public, and `limitSocialWeb` is not
  disabled. The config API does not carry the sidebar's decision; the settings API does.

## Arms (one Ghost at a time)

| Arm | Environment | Expects |
|---|---|---|
| rendered | the golden | the limit line is `true` |
| LOCKED | the golden's lines | config `limitSocialWeb.disabled` is `true`; `social_web` is `true`; `social_web_enabled` is `false` |
| FLIPPED | the same minus the limit line | config does not carry the limit; `social_web` is `true`; `social_web_enabled` is `true` |

`social_web` is asserted on in both, so the limit is what removes the item, not the setting.

## Proving the control

Remove the line from a copy of the golden and point `TENANT_COMPOSE_GOLDEN` at it:
the rendered arm and LOCKED go red (LOCKED against a real boot: no limit in config,
the item shown). Run against the real golden, all three go green. FLIPPED is the
item returning, in the same run.
