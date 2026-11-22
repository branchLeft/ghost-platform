// A tenant image boots with the social web limit on and shows no Network item
// in the admin sidebar; the same image booted without the limit's environment
// line shows the item again. See social-web-limit.md. Real Ghost only.
//
// Usage (Node 22.18 or later runs TypeScript directly):
//   IMAGE=ghost-platform:ci node --test scripts/social-web-limit/social-web-limit.image.test.ts
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GhostAdmin } from '../../services/export-bundler/test/image/ghost-admin.mjs';
import { GhostContainer } from '../../services/export-bundler/test/image/ghost-container.mjs';

const here = new URL('.', import.meta.url);
const LIMIT_KEY = 'hostSettings__limits__limitSocialWeb__disabled';
const PASSWORD = 'Xk9-social-web-limit-image-test-1234';
const BOOT_TEST_TIMEOUT_MS = 300_000;

// The slice of Ghost's admin config API (`/ghost/api/admin/config/`) read here:
// the same `hostSettings.limits` object the admin's own limiter reads.
interface AdminConfigResponse {
  readonly config: {
    readonly hostSettings?: {
      readonly limits?: {
        readonly limitSocialWeb?: { readonly disabled?: boolean; readonly error?: string };
      };
    };
  };
}

// What the admin sidebar decides from. Ghost's Network item renders only when
// the calculated `social_web_enabled` setting is true
// (apps/admin/src/layout/app-sidebar/nav-main.tsx); that setting is true only
// when the `social_web` setting is on, the site is public, and the
// `limitSocialWeb` limit is not disabled (settings-helpers `isSocialWebEnabled`).
interface SocialWebState {
  readonly limitDisabled: boolean | undefined;
  readonly socialWebSetting: unknown;
  readonly networkItemShown: unknown;
}

// The `hostSettings__*` lines of one rendered tenant, first colour block only.
// A line the render does not carry is simply absent here, so sabotaging the
// golden removes the line from the booted container too.
function renderedHostSettings(): Record<string, string> {
  const golden =
    process.env.TENANT_COMPOSE_GOLDEN ??
    new URL('../../render-core/test/golden/entry-tenant.compose.yml', here);
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(golden, 'utf8').split('\n')) {
    const found = /^\s+(hostSettings__\w+): (\S+)\s*$/.exec(line);
    const key = found?.[1];
    const value = found?.[2];
    if (key !== undefined && value !== undefined && !(key in env)) env[key] = value;
  }
  return env;
}

const containers: GhostContainer[] = [];

// One Ghost at a time: the container is removed before the caller returns.
async function withGhost<T>(
  env: Record<string, string>,
  email: string,
  read: (admin: GhostAdmin) => Promise<T>
): Promise<T> {
  const container = await GhostContainer.start(env);
  containers.push(container);
  try {
    const admin = new GhostAdmin(container);
    await admin.setupOwner({ email, password: PASSWORD, siteTitle: 'SITE_TITLE' });
    return await read(admin);
  } finally {
    container.remove();
  }
}

async function readSocialWebState(admin: GhostAdmin): Promise<SocialWebState> {
  const { config } = (await admin.json('/config/')) as AdminConfigResponse;
  const settings = (await admin.settingsMap()) as Record<string, unknown>;
  return {
    limitDisabled: config.hostSettings?.limits?.limitSocialWeb?.disabled,
    socialWebSetting: settings.social_web,
    networkItemShown: settings.social_web_enabled,
  };
}

describe('the social web limit reaches a booted tenant image', () => {
  after(() => {
    for (const container of containers) container.remove();
  });

  const hostSettings = renderedHostSettings();
  const { [LIMIT_KEY]: _limit, ...withoutLimit } = hostSettings;

  it('render-core renders the limit line for a tenant', () => {
    assert.equal(hostSettings[LIMIT_KEY], 'true', `render-core must render ${LIMIT_KEY}: true`);
  });

  it(
    'LOCKED: with the line, the limit is on and the sidebar has no Network item',
    { timeout: BOOT_TEST_TIMEOUT_MS },
    async () => {
      const state = await withGhost(hostSettings, 'owner-locked@example.test', readSocialWebState);
      assert.equal(state.limitDisabled, true, 'admin config must carry limitSocialWeb.disabled');
      // The setting is on, so the limit is what keeps the item away.
      assert.equal(state.socialWebSetting, true);
      assert.equal(state.networkItemShown, false, 'the Network item must be absent');
    }
  );

  it(
    'FLIPPED: without the line, the limit is gone and the Network item returns',
    { timeout: BOOT_TEST_TIMEOUT_MS },
    async () => {
      const state = await withGhost(withoutLimit, 'owner-flipped@example.test', readSocialWebState);
      assert.notEqual(state.limitDisabled, true, 'the limit must not reach admin config');
      assert.equal(state.socialWebSetting, true);
      assert.equal(state.networkItemShown, true, 'the Network item must be back');
    }
  );
});
