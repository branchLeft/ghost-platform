/**
 * The owner is a reader of every demo, and a demo is never created without
 * that. Each control case is proven by sabotage: the same scenario runs against
 * a copy of the real module with one protection changed (RED: the harm
 * happens) and then against the real module (GREEN: it does not).
 */
import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmailAddress, SlotName } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import { adminApiConfigFromEnv } from '../../src/config.js';
import type * as ClientModule from '../../src/ghostAdmin/client.js';
import * as realClient from '../../src/ghostAdmin/client.js';
import { createAdminKeyStore } from '../../src/ghostAdmin/keyStore.js';
import type * as DueDiligenceModule from '../../src/ownerDueDiligence.js';
import * as realDueDiligence from '../../src/ownerDueDiligence.js';
import { demoDescriptor, TEST_ZONES } from '../helpers/fixtures.js';
import { startFakeGhost, type FakeGhost } from '../helpers/fakeGhost.js';

const OWNER = 'owner-review@example.invalid' as EmailAddress;
const SLOT = '0' as SlotName;
const SRC = join(import.meta.dirname, '..', '..', 'src');
const TMP = join(import.meta.dirname, '..', '.sabotage-owner-reader-tmp');

/**
 * Imports a throwaway copy of a source file with one text mutation. A
 * mutation that changes nothing throws, so a sabotage can never become a
 * quiet no-op after the source moves.
 */
async function sabotaged<T>(
  relPath: string,
  target: string,
  replacement: string,
  siblings: Record<string, string> = {}
): Promise<T> {
  const original = readFileSync(join(SRC, relPath), 'utf-8');
  if (!original.includes(target)) throw new Error(`sabotage target not found in ${relPath}`);
  let text = original.replace(target, replacement);
  // The copy lives in TMP, so every relative import must point back into src/.
  text = text.replace(/from '(\.\.?\/[^']+)'/g, (_m, spec: string) => {
    const resolved = join(SRC, relPath, '..', spec);
    return `from '${siblings[spec] ?? resolved}'`;
  });
  mkdirSync(TMP, { recursive: true });
  const out = join(TMP, `${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(out, text);
  try {
    return (await import(/* @vite-ignore */ out)) as T;
  } finally {
    rmSync(out, { force: true });
  }
}

afterAll(() => {
  try {
    rmdirSync(TMP);
  } catch {
    // already gone, or not empty: never a recursive removal
  }
});

describe('the owner as a reader of a demo', () => {
  let ghost: FakeGhost;
  let keyDir: string;
  beforeEach(async () => {
    ghost = await startFakeGhost();
    keyDir = join(await makeTempDir('broker-owner-reader-'), 'keys');
  });
  afterEach(async () => {
    await ghost.close();
  });

  const baseUrl = () => `http://127.0.0.1:${ghost.port}`;
  function build(mod: typeof ClientModule) {
    return mod.createGhostAdminClient({
      keyStore: createAdminKeyStore(keyDir),
      zones: TEST_ZONES,
      readyTimeoutMs: 5_000,
      ownerReader: OWNER,
      sleep: async () => undefined,
    });
  }

  it('a new demo has the owner as a member and no staff beyond its own owner', async () => {
    await build(realClient).configure(baseUrl(), demoDescriptor(), SLOT);
    expect(ghost.members).toEqual([OWNER]);
    expect(ghost.staffAdded).toEqual([]);
  });

  it('adds the owner once: a second configure finds the member and adds nothing', async () => {
    const client = build(realClient);
    await client.configure(baseUrl(), demoDescriptor(), SLOT);
    await client.configure(baseUrl(), demoDescriptor(), SLOT);
    expect(ghost.members).toEqual([OWNER]);
  });

  it('puts the owner address in no error when Ghost refuses', async () => {
    ghost.overrides.set('POST /members/', { status: 422, body: { errors: [{ message: 'x' }] } });
    const failure = await build(realClient)
      .configure(baseUrl(), demoDescriptor(), SLOT)
      .then(
        () => '',
        (err: Error) => err.message
      );
    expect(failure).toMatch(/refused adding the due-diligence reader: 422/);
    expect(failure).not.toContain('example.invalid');
  });

  it('refuses a reader whose address Ghost does not read back', async () => {
    ghost.overrides.set('POST /members/', {
      status: 201,
      body: { members: [{ email: 'someone-else@example.invalid' }] },
    });
    await expect(build(realClient).configure(baseUrl(), demoDescriptor(), SLOT)).rejects.toThrow(
      /did not read back/
    );
  });

  it('SABOTAGE reader-only: the owner added as an administrator turns the staff assertion red', async () => {
    const bad = await sabotaged<typeof ClientModule>(
      'ghostAdmin/client.ts',
      `const created = await call(target, 'POST', '/members/', {
      body: { members: [{ email: ownerReader }] },
      headers,
    });
    if (created.status !== 201) {`,
      `const created = await call(target, 'POST', '/invites/', {
      body: { invites: [{ email: ownerReader, role: 'Administrator' }] },
      headers,
    });
    if (created.status !== 201) {`
    );
    const run = bad.createGhostAdminClient({
      keyStore: createAdminKeyStore(keyDir),
      zones: TEST_ZONES,
      readyTimeoutMs: 5_000,
      ownerReader: OWNER,
      sleep: async () => undefined,
    });
    await run.configure(baseUrl(), demoDescriptor(), SLOT).catch(() => undefined);
    // RED: the sabotaged client did add staff, and the real assertion catches it.
    expect(ghost.staffAdded).toEqual([{ email: OWNER, role: 'Administrator' }]);
    expect(ghost.staffAdded).not.toEqual([]);
    // GREEN is the first test above: the real client leaves staffAdded empty.
  });
});

describe('a demo is refused when the setting is unset', () => {
  const zonesEnv = {
    BROKER_ADMIN_KEY_DIR: '/k',
    BROKER_DEMO_ZONE: TEST_ZONES.demoZone,
    BROKER_PLATFORM_ZONE: TEST_ZONES.platformZone,
    BROKER_OWNED_DOMAINS: TEST_ZONES.ownedDomains.join(','),
    BROKER_DEMO_MAIL_DOMAIN: TEST_ZONES.demoMailDomain,
  };

  it.each([undefined, '', '   ', 'not-an-address', "o'wner@example.invalid"])(
    'refuses %j at config load, naming the setting and never the value',
    (value) => {
      const attempt = () =>
        adminApiConfigFromEnv({ ...zonesEnv, OWNER_DUE_DILIGENCE_EMAIL: value });
      expect(attempt).toThrow(realDueDiligence.OwnerDueDiligenceUnsetError);
      expect(attempt).toThrow(/OWNER_DUE_DILIGENCE_EMAIL/);
      if (value && value.trim() !== '') expect(attempt).not.toThrow(new RegExp(value));
    }
  );

  it('refuses to build a client without the owner, however the option is passed', () => {
    for (const ownerReader of [undefined, '', ' ']) {
      expect(() =>
        realClient.createGhostAdminClient({
          keyStore: createAdminKeyStore('/never-used'),
          zones: TEST_ZONES,
          readyTimeoutMs: 1,
          ownerReader: ownerReader as unknown as EmailAddress,
        })
      ).toThrow(realDueDiligence.OwnerDueDiligenceUnsetError);
    }
  });

  it('reads a valid address from the environment', () => {
    expect(
      adminApiConfigFromEnv({ ...zonesEnv, OWNER_DUE_DILIGENCE_EMAIL: OWNER }).ownerReader
    ).toBe(OWNER);
  });

  it('SABOTAGE refusal: with the check removed an unset value is accepted, and the refusal assertion turns red', async () => {
    const bad = await sabotaged<typeof DueDiligenceModule>(
      'ownerDueDiligence.ts',
      "if (typeof value !== 'string' || value.trim() === '') {\n    throw new OwnerDueDiligenceUnsetError('is not set');\n  }",
      "if (typeof value !== 'string') {\n    return '' as EmailAddress;\n  }"
    );
    // RED: the sabotaged module lets an unset setting through as an empty reader.
    expect(() => bad.ownerDueDiligenceEmailFromEnv({})).not.toThrow();
    // GREEN: the real module refuses.
    expect(() => realDueDiligence.ownerDueDiligenceEmailFromEnv({})).toThrow(
      /OWNER_DUE_DILIGENCE_EMAIL is not set/
    );
  });
});
