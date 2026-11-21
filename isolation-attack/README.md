# Tenant isolation attack suite

A targeted browser attack suite for tenants that share a parent domain. Each case is one attack aimed at one control. A case is **held** when the control stopped the attack, **breached** when it did not, and **not exercised** when the attack never reached the control (that fails the suite too: an attack that was not run proves nothing). Every case is also run with its control switched off, and must go red there; a case that stays green cannot see its own control.

It runs against two disposable local tenants, or against a deployed shared domain by a base-URL parameter, and writes a dated report that carries the image digests.

## The cases

| Case | The attack | The control under test | Switched off for the red run |
| --- | --- | --- | --- |
| `uploaded-script` | Tenant B uploads a script, an HTML document and an SVG through Ghost's file upload, then loads them | The edge refuses an uploaded file a browser would run (the guard `demo-host/provision/render_demo_site.py --print-upload-guard` prints) | `no-upload-guard` |
| `inline-script` | Tenant B injects script by site-wide head and foot injection, a post's HTML card and an event-handler attribute | The edge content policy: `script-src 'self'` plus derived hashes (render-core `renderEdgeSiteBlock`) | `no-csp` |
| `cookie-tossing` | A reader signed in to tenant A browses tenant B, whose script writes cookies for the shared domain, A's session cookie name among them | No tenant script runs on the shared domain, so no cookie is written | `no-csp` |
| `portal-host-cookies` | With script assumed to be running on a tenant, it tries to replace, widen or shadow each cookie the portal sets | The `__Host-` prefix on the portal's cookies (`portal/apps/src/shell/cookies.ts`) | `portal-prefix-off` |
| `cookie-bomb` | Tenant B writes enough cookie bytes for the shared domain that A's next request is refused | No tenant script runs on the shared domain | `no-csp` |
| `cross-site-request` | A forged POST to A's "copy post" action, by form and by opaque fetch, from the attacker's own site and from tenant B | Ghost's admin API refuses a request whose Origin is not the tenant's own | `origin-spoof` (the edge rewrites Origin) |
| `theme-script` | Tenant B uploads and activates a theme with an inline script and a script file | A tenant cannot serve a theme the platform has not admitted | `no-csp` |

### Residual measurements

The cases above judge the harm. Two of them also measure what the browser would allow if the other controls had failed, because only a Public Suffix List entry for the shared domain removes it. The result is `accepted-risk` while the entry is not in place, `held` once the browser refuses the write, and `breached` if the operator states the entry is in place (`ATTACK_PSL=present`) and the browser accepts the write anyway.

- `cookie-tossing`: with script already running on tenant B, does the browser accept a cookie for the shared domain, and do tenant A and the portal receive it?
- `cookie-bomb`: the one oversize-cookie request: with the cookies written, what does tenant A answer (Ghost refuses a request header over 16 KiB), and does it recover once they are cleared? One request, never repeated.

## Run it against the local rig

Needs Docker, Chromium (`pnpm exec playwright install chromium`), Python 3 and Node from `.nvmrc`.

```sh
cd isolation-attack
pnpm install --frozen-lockfile
pnpm run attack
```

The rig builds the repository's own platform image and the proof origin image, starts two Ghost tenants (`a.sites.pp.localhost` and `b.sites.pp.localhost`) behind one Caddy edge, and starts the portal stand-in (`portal.pp.localhost`) and the attacker's own site in the test process. `*.localhost` names resolve to loopback in a browser, so nothing else is configured, and `pp.localhost` stands in for the registrable domain (it is not on the Public Suffix List, which is the state the shared domain is in until its entry lands).

Everything is removed at the end and named `isoattack-`, so a killed run's leftovers are swept at the next start. The suite runs once: build one result, write the report. Set `ATTACK_GHOST_IMAGE` to attack an image you already have instead of building one.

What the rig stands in for, and does not: the edge is the proof origin's Caddy with the demo edge's upload refusal and render-core's policy, not the deployed tenant edge; the portal is a stand-in that calls the portal's own cookie functions, because the real portal needs a database and an identity provider; and the tenants are served over plain HTTP, where Ghost sets `SameSite=Lax` on its session cookie (over HTTPS it sets `SameSite=None`, so a deployed run is the stronger test of `cross-site-request`).

## Run it against a deployed shared domain

Not run from this repository's CI. Both tenants must be throwaway: the suite plants hostile content on both and sends one oversize-cookie request. It refuses to start without `ATTACK_CONFIRM`.

Read each secret into the shell without echoing it, then run:

```sh
read -rs ATTACK_ADMIN_A_PASSWORD; export ATTACK_ADMIN_A_PASSWORD
read -rs ATTACK_ADMIN_B_PASSWORD; export ATTACK_ADMIN_B_PASSWORD
ATTACK_BASE_URL=https://<shared domain> \
ATTACK_ROOT_DOMAIN=<registrable domain above it> \
ATTACK_CONFIRM=both-tenants-are-throwaway \
ATTACK_TENANT_A=<victim tenant label> ATTACK_TENANT_B=<attacker tenant label> \
ATTACK_ADMIN_A_EMAIL=<owner of A> ATTACK_ADMIN_B_EMAIL=<owner of B> \
ATTACK_PORTAL_URL=https://<portal host> \
ATTACK_PSL=absent \
ATTACK_IMAGE_DIGESTS=<registry>/<image>@sha256:<64 hex>,... \
pnpm run attack
```

| Variable | Meaning |
| --- | --- |
| `ATTACK_BASE_URL` | The shared tenant domain alone: scheme and host, no path or port. Unset means the local rig. |
| `ATTACK_ROOT_DOMAIN` | The registrable domain above it, which the portal sits under. |
| `ATTACK_CONFIRM` | Must be `both-tenants-are-throwaway`. |
| `ATTACK_TENANT_A`, `ATTACK_TENANT_B` | The victim's and the attacker's tenant labels. The hosts are `<label>.<shared domain>`. |
| `ATTACK_ADMIN_A_EMAIL`, `ATTACK_ADMIN_A_PASSWORD`, and the same for `B` | Each tenant's owner. Signed in once each. |
| `ATTACK_PORTAL_URL`, `ATTACK_PORTAL_LOGIN_PATH` | The portal's origin, and the path that makes it set its cookies (`/login`). The deployed portal cannot be signed in without an identity provider, so only the cookies it sets at sign-in start are attacked. |
| `ATTACK_PSL` | `absent` (default) or `present`: whether the shared domain has a Public Suffix List entry. |
| `ATTACK_IMAGE_DIGESTS` | Comma-separated `name@sha256:<64 hex>` of the images the deployed tenants run, read from the registry or the host by the operator. Recorded as supplied. |

A deployed run cannot switch controls off, so it records no red runs and its report says so.

## The dated report

The run writes `results/results.json` and a dated fragment, `results/<date>-cookie-isolation-attack-<local-rig|deployed>.html`: a dated note and two tables (every case with its control, verdict, red run and evidence; every image with its id and registry digests). The date is the run's own finish time.

The design pages that carry the dated cookie-isolation notes are in the private `ghost-platform-docs` repository (`19-try-it-now-design/00-high-level-design.html` and `01-tenant-descriptor.html`), so this repository writes the fragment and does not touch them: whoever lands the note pastes it beside the existing dated note. To regenerate it from a results file:

```sh
pnpm run report --results results/results.json --out <directory>
```

The command exits non-zero unless every case held and every red run went red.

## Tests

`pnpm run typecheck` and `pnpm run test:unit` need neither Docker nor a browser: they cover each verdict rule (held, breached and not exercised), the report, the target parameters and the edge rendering. They run in CI (`.github/workflows/isolation-attack-ci.yml`).

`test/attack/portalCookies.attack.ts` needs Chromium and no Docker. It is the portal case's own sabotage proof: the production wiring must hold and the same stand-in without the prefix must be breached.

```sh
pnpm exec vitest run --config vitest.attack.config.ts test/attack/portalCookies.attack.ts
```
