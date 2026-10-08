import * as pulumi from '@pulumi/pulumi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GhostTenant as GhostTenantClass } from './index';
import { TEST_ZONES, tenantZeroEquivalent, tenantZeroSecrets } from './test/fixtures';
import { created, installMocks, settle, unwrap } from './test/harness';

/**
 * The owner's email address reaches the host only through the secrets file.
 * A sentinel address no other value could contain is passed in, and every
 * output this component exposes is searched for it: only the secrets file
 * may carry it, and that output must be a Pulumi secret. See
 * index.md#the-owner-address.
 */

const SENTINEL_LOCAL = 'owner-sentinel-9b4d2e61';
const SENTINEL = `${SENTINEL_LOCAL}@sentinel-owner.example.test`;

let GhostTenant: typeof GhostTenantClass;

beforeAll(async () => {
  installMocks();
  ({ GhostTenant } = await import('./index.js'));
});

function build(name: string, ownerEmail: pulumi.Input<string>): GhostTenantClass {
  return new GhostTenant(name, {
    descriptor: tenantZeroEquivalent(),
    zones: TEST_ZONES,
    secrets: { ...tenantZeroSecrets(), ownerEmail },
  });
}

function contains(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.toLowerCase().includes(SENTINEL_LOCAL);
}

/** Every public field of the component, Outputs resolved, split by secrecy. */
async function exposed(
  tenant: GhostTenantClass
): Promise<{ plain: Map<string, unknown>; secret: Map<string, unknown> }> {
  const plain = new Map<string, unknown>();
  const secret = new Map<string, unknown>();
  for (const [field, value] of Object.entries(tenant)) {
    if (field.startsWith('__')) {
      continue;
    }
    if (pulumi.Output.isInstance(value)) {
      const target = (await pulumi.isSecret(value)) ? secret : plain;
      target.set(field, await unwrap(value));
    } else {
      plain.set(field, value);
    }
  }
  return { plain, secret };
}

describe.each([
  ['a plain string', (): pulumi.Input<string> => SENTINEL],
  ['a Pulumi secret, as config.requireSecret gives it', () => pulumi.secret(SENTINEL)],
])('the owner address passed as %s', (label, ownerEmail) => {
  const name = `owner-${label.length}`;

  it('appears in no non-secret output', async () => {
    const { plain } = await exposed(build(name, ownerEmail()));
    expect(plain.size).toBeGreaterThan(10);
    for (const [field, value] of plain) {
      expect(contains(value), field).toBe(false);
    }
  });

  it('appears only in the secrets file, which is a Pulumi secret', async () => {
    const { secret } = await exposed(build(`${name}-secret`, ownerEmail()));
    expect([...secret.keys()]).toEqual(['secretsEnvFile']);
    expect(secret.get('secretsEnvFile')).toContain(`GHOST_OWNER_EMAIL=${SENTINEL}\n`);
  });

  it('appears in no input the component registers', async () => {
    build(`${name}-inputs`, ownerEmail());
    await settle();
    const registered = created.filter((r) => r.name === `${name}-inputs`);
    expect(registered).toHaveLength(1);
    expect(contains(registered[0].inputs)).toBe(false);
  });

  // Pulumi's mocks never show a test what `registerOutputs()` records, yet
  // that map is what the stack state stores. Capture it at the call.
  it('appears in no recorded output except the secrets file, as a secret', async () => {
    const recorded = await recordedOutputs(`${name}-recorded`, ownerEmail());
    expect(recorded.size).toBeGreaterThan(10);
    const carriers: string[] = [];
    for (const [key, { secret, value }] of recorded) {
      if (contains(value)) {
        carriers.push(key);
        expect(secret, `${key} records the owner address in plain`).toBe(true);
      }
    }
    expect(carriers).toEqual(['secretsEnvFile']);
  });
});

/** The map the component passed to `registerOutputs()`, each entry resolved
 * and marked with whether Pulumi would store it as a secret. */
async function recordedOutputs(
  name: string,
  ownerEmail: pulumi.Input<string>
): Promise<Map<string, { secret: boolean; value: unknown }>> {
  const calls: Record<string, unknown>[] = [];
  // `registerOutputs` is protected, so it is reached through a structural view.
  const prototype = pulumi.ComponentResource.prototype as unknown as {
    registerOutputs(outputs?: unknown): void;
  };
  const spy = vi.spyOn(prototype, 'registerOutputs').mockImplementation((outputs?: unknown) => {
    calls.push(outputs as Record<string, unknown>);
  });
  try {
    build(name, ownerEmail);
  } finally {
    spy.mockRestore();
  }
  expect(calls).toHaveLength(1);
  const recorded = new Map<string, { secret: boolean; value: unknown }>();
  for (const [key, raw] of Object.entries(calls[0])) {
    const output = pulumi.output(raw as pulumi.Input<unknown>);
    recorded.set(key, { secret: await pulumi.isSecret(output), value: await unwrap(output) });
  }
  return recorded;
}

/**
 * Pulumi registers the component's outputs without awaiting them, so a
 * refusal inside the secret also rejects there, unobserved; a real deploy
 * fails on it with the same message. Each case below collects those
 * rejections instead of letting them escape the test, and checks them too.
 */
async function refusals(name: string, ownerEmail: string): Promise<Error[]> {
  const seen: Error[] = [];
  const collect = (reason: unknown): void => {
    seen.push(reason as Error);
  };
  const vitestListeners = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', collect);
  try {
    const tenant = build(name, ownerEmail);
    await (tenant.secretsEnvFile as unknown as { promise(): Promise<string> }).promise().then(
      () => seen.push(new Error('expected a refusal, got none')),
      (refusal: Error) => seen.push(refusal)
    );
    await settle();
    await settle();
  } finally {
    process.removeListener('unhandledRejection', collect);
    for (const listener of vitestListeners) {
      process.on('unhandledRejection', listener);
    }
  }
  return seen;
}

describe('a malformed owner address', () => {
  it('is refused at deploy time, inside the secret, with the value withheld', async () => {
    const seen = await refusals('owner-malformed', `${SENTINEL_LOCAL}-has-no-at-sign`);
    expect(seen.length).toBeGreaterThan(0);
    for (const error of seen) {
      expect(error.message).toMatch(/GHOST_OWNER_EMAIL is not a valid email address/);
      expect(contains(error.message)).toBe(false);
    }
  });

  it('carrying a newline is refused the same way, never written as a second line', async () => {
    const seen = await refusals('owner-newline', `${SENTINEL}\nGHOST_DB_PASSWORD=x`);
    expect(seen.length).toBeGreaterThan(0);
    for (const error of seen) {
      expect(error.message).toMatch(/GHOST_OWNER_EMAIL is not a valid email address/);
      expect(contains(error.message)).toBe(false);
    }
  });
});
