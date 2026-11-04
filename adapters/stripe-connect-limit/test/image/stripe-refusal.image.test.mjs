// A demo slot cannot store a Stripe key by any route; a paired control (same
// image, same env minus the limit key) is not refused for the limit's reason.
// See stripe-refusal.image.test.md. Real Ghost only, every value PLACEHOLDER.
//
// Usage:
//   IMAGE=ghost-platform:ci node --test adapters/stripe-connect-limit/test/image/*.test.mjs
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { importFailureSection, readUntilStable } from './import-log.mjs';
import { GhostAdmin } from '../../../../services/export-bundler/test/image/ghost-admin.mjs';
import {
  GhostContainer,
  docker,
} from '../../../../services/export-bundler/test/image/ghost-container.mjs';

const here = new URL('.', import.meta.url);
const repoFile = (relative) => new URL(`../../../../${relative}`, here);
const OVERLAY = 'adapters/stripe-connect-limit/ghost-core-overlay';
const LIMIT_KEY = 'hostSettings__limits__limitStripeConnect__disabled';
const PASSWORD = 'Xk9-stripe-refusal-image-test-1234';
const PLACEHOLDER = 'PLACEHOLDER';
const SETTINGS_FILE = '/var/lib/ghost/current/core/server/models/settings.js';
const IMPORT_FAILED = 'Content import was unsuccessful';
const IMPORT_WAIT_MS = 60_000;

// The `hostSettings__*` lines of a rendered demo, first colour block only.
function demoHostSettings() {
  const compose =
    process.env.DEMO_COMPOSE_GOLDEN ?? repoFile('render-core/test/golden/demo.compose.yml');
  const env = {};
  for (const line of fs.readFileSync(compose, 'utf8').split('\n')) {
    const found = /^\s+(hostSettings__\w+): (\S+)\s*$/.exec(line);
    if (found && !(found[1] in env)) env[found[1]] = found[2];
  }
  return env;
}

// The refusal text lives in one place: the line the patch adds.
function refusalText() {
  const patch = fs.readFileSync(repoFile(`${OVERLAY}/stripe-connect-limit.patch`), 'utf8');
  const found = /^\+\s+demoStripeConnectRefused: '([^']+)',?$/m.exec(patch);
  assert.ok(found, 'the patch must add a demoStripeConnectRefused message line');
  return found[1];
}

const REFUSAL = refusalText();
const containers = [];

async function freshGhost(extraEnv, email) {
  const container = await GhostContainer.start(extraEnv);
  containers.push(container);
  const admin = new GhostAdmin(container);
  await admin.setupOwner({ email, password: PASSWORD, siteTitle: 'SITE_TITLE' });
  return { container, admin };
}

const errorsOf = (res) => JSON.parse(res.text).errors ?? [];
// Ghost carries the specific reason in `context`; `message` is the generic wrapper.
const describeErrors = (res) =>
  errorsOf(res)
    .map((e) => `${e.message} ${e.context ?? ''}`)
    .join(' | ');

const putSettings = (admin, entries) =>
  admin.call('PUT', '/settings/', {
    settings: Object.entries(entries).map(([key, value]) => ({ key, value })),
  });

// Ghost's native Connect-token route: take the state it stores on the session,
// then send a token carrying that state and PLACEHOLDER keys.
async function connectToken(admin) {
  const start = await admin.call('GET', '/members/stripe_connect/?mode=test');
  assert.equal(
    start.status,
    302,
    `Connect start answered ${start.status}: ${start.text.slice(0, 200)}`
  );
  const state = new URL(start.headers.location).searchParams.get('state');
  assert.ok(state, 'the Connect redirect must carry a state');
  const fresh = (start.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);
  if (fresh.length > 0) admin.cookie = fresh.join('; ');
  const token = Buffer.from(
    JSON.stringify({
      s: state,
      p: PLACEHOLDER,
      a: PLACEHOLDER,
      l: false,
      n: PLACEHOLDER,
      i: PLACEHOLDER,
    })
  ).toString('base64');
  return putSettings(admin, { stripe_connect_integration_token: token });
}

// A minimal export: one marker tag, and optionally a Stripe key row.
function importFile(markerSlug, { withStripeKey }) {
  const now = new Date().toISOString();
  const row = (extra) => ({
    id: crypto.randomBytes(12).toString('hex'),
    created_at: now,
    updated_at: now,
    ...extra,
  });
  return Buffer.from(
    JSON.stringify({
      db: [
        {
          meta: { exported_on: Date.now(), version: '6.0.0' },
          data: {
            tags: [row({ name: markerSlug, slug: markerSlug })],
            settings: withStripeKey
              ? [
                  row({
                    key: 'stripe_secret_key',
                    value: PLACEHOLDER,
                    type: 'string',
                    group: 'members',
                  }),
                ]
              : [],
          },
        },
      ],
    })
  );
}

const stripeSecret = async (admin) => (await admin.settingsMap()).stripe_secret_key;
const tagSlugs = async (admin) => (await admin.listTags()).map((t) => t.slug);
const containerLog = (container) => docker('logs', container.name);
const countFailures = (container) => containerLog(container).split(IMPORT_FAILED).length - 1;

async function until(what, probe) {
  const deadline = Date.now() + IMPORT_WAIT_MS;
  while (Date.now() < deadline) {
    const found = await probe();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`gave up waiting for ${what} after ${IMPORT_WAIT_MS}ms`);
}

// Runs one import and returns what Ghost logged for it. `withStripeKey: false`
// is the visibility check: its marker tag must appear, or an absent marker
// after a Stripe import would prove nothing.
async function runImport({ container, admin }, markerSlug, { withStripeKey }) {
  const failuresBefore = countFailures(container);
  const res = await admin.importContentRaw(importFile(markerSlug, { withStripeKey }));
  assert.equal(
    res.status,
    200,
    `Ghost accepts every import for a background job: ${res.text.slice(0, 200)}`
  );
  if (!withStripeKey) {
    await until(`marker tag ${markerSlug}`, async () =>
      (await tagSlugs(admin)).includes(markerSlug)
    );
    return '';
  }
  await until('the import job to log its failure', () => countFailures(container) > failuresBefore);
  // The marker can be logged before its reason lines: read until the log is still.
  const log = await readUntilStable(() => containerLog(container));
  return importFailureSection(log, IMPORT_FAILED, failuresBefore);
}

describe(
  'a demo cannot store a Stripe key; the control can reach Ghost validation',
  { timeout: 900_000 },
  () => {
    let demo;
    let control;
    let hostSettings;

    before(async () => {
      hostSettings = demoHostSettings();
      const { [LIMIT_KEY]: _limit, ...withoutLimit } = hostSettings;
      demo = await freshGhost(hostSettings, 'owner-demo@example.test');
      control = await freshGhost(withoutLimit, 'owner-control@example.test');
    });

    after(() => {
      for (const container of containers) container.remove();
    });

    it('the rendered demo environment carries the Stripe limit key', () => {
      assert.equal(
        hostSettings[LIMIT_KEY],
        'true',
        `render-core must render ${LIMIT_KEY} for a demo`
      );
    });

    it('the built image holds the pinned patched settings model', () => {
      const pin = fs.readFileSync(
        repoFile(`${OVERLAY}/stripe-connect-limit.patched.sha256`),
        'utf8'
      );
      const expected = pin.trim().split(/\s+/)[0];
      const out = docker(
        'run',
        '--rm',
        '--entrypoint',
        'sha256sum',
        process.env.IMAGE,
        SETTINGS_FILE
      );
      assert.equal(out.trim().split(/\s+/)[0], expected);
    });

    it('ARM A: the Connect token is refused with the host-limit error; no key is stored', async () => {
      const res = await connectToken(demo.admin);
      assert.equal(res.status, 403, describeErrors(res));
      assert.equal(errorsOf(res)[0].type, 'HostLimitError');
      assert.equal(await stripeSecret(demo.admin), null);
    });

    it('ARM B: a direct key PUT is refused with the refusal text, not a format error; no key is stored', async () => {
      const res = await putSettings(demo.admin, { stripe_secret_key: PLACEHOLDER });
      assert.equal(res.status, 403, describeErrors(res));
      assert.equal(errorsOf(res)[0].type, 'NoPermissionError');
      assert.equal(errorsOf(res)[0].context, REFUSAL);
      assert.doesNotMatch(describeErrors(res), /did not match/);
      assert.equal(await stripeSecret(demo.admin), null);
    });

    it('ARM B: the publishable key is refused the same way', async () => {
      const res = await putSettings(demo.admin, { stripe_publishable_key: PLACEHOLDER });
      assert.equal(res.status, 403, describeErrors(res));
      assert.equal(errorsOf(res)[0].context, REFUSAL);
      assert.equal((await demo.admin.settingsMap()).stripe_publishable_key, null);
    });

    it('ARM B: clearing a Stripe key (null) is still allowed', async () => {
      const res = await putSettings(demo.admin, { stripe_secret_key: null });
      assert.equal(res.status, 200, describeErrors(res));
    });

    it('ARM C: an import carrying a Stripe key is rejected as a whole and rolls back', async () => {
      await runImport(demo, 'demo-marker-visible', { withStripeKey: false });
      const log = await runImport(demo, 'demo-marker-rolled-back', { withStripeKey: true });
      assert.ok(
        log.includes(REFUSAL),
        `the failure must carry the refusal text: ${log.slice(0, 400)}`
      );
      assert.equal(await stripeSecret(demo.admin), null);
      const slugs = await tagSlugs(demo.admin);
      assert.ok(slugs.includes('demo-marker-visible'), 'an import with no Stripe row is applied');
      assert.ok(!slugs.includes('demo-marker-rolled-back'), 'the whole import must roll back');
    });

    it('ARM D: paid tiers stay visible on the demo', async () => {
      const { tiers } = await demo.admin.json('/tiers/?limit=all');
      assert.ok(
        tiers.some((t) => t.type === 'paid'),
        `tiers: ${tiers.map((t) => t.type)}`
      );
    });

    it('CONTROL A: without the limit the Connect token reaches Ghost format validation', async () => {
      const res = await connectToken(control.admin);
      assert.notEqual(errorsOf(res)[0]?.type, 'HostLimitError', describeErrors(res));
      assert.ok(!describeErrors(res).includes(REFUSAL));
      assert.match(describeErrors(res), /did not match/);
      assert.equal(await stripeSecret(control.admin), null);
    });

    it('CONTROL B: without the limit a direct key PUT reaches Ghost format validation', async () => {
      const res = await putSettings(control.admin, { stripe_secret_key: PLACEHOLDER });
      assert.ok(!describeErrors(res).includes(REFUSAL));
      assert.match(describeErrors(res), /did not match/);
      assert.equal(await stripeSecret(control.admin), null);
    });

    it('CONTROL C: without the limit the import fails on the format check, not the refusal', async () => {
      await runImport(control, 'control-marker-visible', { withStripeKey: false });
      const log = await runImport(control, 'control-marker-rolled-back', { withStripeKey: true });
      assert.match(log, /did not match/);
      assert.ok(!log.includes(REFUSAL), 'the control must not carry the refusal text');
      const slugs = await tagSlugs(control.admin);
      assert.ok(slugs.includes('control-marker-visible'));
      assert.ok(!slugs.includes('control-marker-rolled-back'));
    });
  }
);
