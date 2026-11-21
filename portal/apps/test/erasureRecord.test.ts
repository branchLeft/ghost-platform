import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { TenantDb, bindTenant } from 'ghost-platform-portal-data/tenant';
import { createFixture, TENANT_A, TENANT_B, type Fixture } from '../../data/test/helpers.js';
import { nameTenant } from '../../data/test/supportAccessAdmin.js';
import { tenantErasureRequest } from '../../data/src/schema.js';
import {
  PROOF_GREEN_TEXT,
  recordKeyDestruction,
  type ErasureSink,
  type RecordOutcome,
} from '../src/erasure/record.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

const green = (slug: string): string =>
  `erase_tenant_backup_identity: ${slug}: ${PROOF_GREEN_TEXT}`;
const NOTHING = (slug: string): string =>
  `erase_tenant_backup_identity: ${slug}: no copy of its backup identity was present; nothing to erase`;
const ALERT = (slug: string): string =>
  `erase_tenant_backup_identity: ALERT: ${slug}: the erasure proof is RED; the tenant's backup identity is not shown to be gone`;

let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
  await nameTenant(fixture, TENANT_A, 'alpha-news');
  await nameTenant(fixture, TENANT_B, 'beta-post');
  clearMutants();
});

afterAll(async () => {
  clearMutants();
  await fixture.close();
});

beforeEach(async () => {
  await fixture.adminDb.delete(tenantErasureRequest);
});

const statusOf = async (tenantId: string): Promise<string | null> =>
  (await fixture.adminDb.select().from(tenantErasureRequest)).find((r) => r.tenantId === tenantId)
    ?.status ?? null;

function run(
  text: string,
  sink: ErasureSink = owner
): Promise<RecordOutcome> & { lines: string[] } {
  const lines: string[] = [];
  const promise = recordKeyDestruction(sink, text, (line) => lines.push(line));
  return Object.assign(promise, { lines });
}

describe('recording a destroyed key from the erase command output', () => {
  it('records a waiting request from the command’s green line, at the database clock', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const outcome = await run(`${green('alpha-news')}\n`);
    expect(outcome).toEqual({ recorded: true, slug: 'alpha-news' });
    expect(await statusOf(TENANT_A)).toBe('key_destroyed');
    expect((await tenant.ownErasure(bindTenant(TENANT_A))).state).toBe('key_destroyed');
  });

  it('logs the slug and the outcome and nothing of the text', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const pending = run(`secret-looking-noise\n${green('alpha-news')}\n`);
    await pending;
    expect(pending.lines).toEqual(['erasure: alpha-news: recorded key destroyed']);
  });

  it('control case: the "nothing to erase" line is not a proof, so nothing is recorded', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const outcome = await run(`${NOTHING('alpha-news')}\n`);
    expect(outcome).toEqual({ recorded: false, why: 'no-green-proof' });
    expect(await statusOf(TENANT_A)).toBe('requested');
  });

  it('control case: a red run records nothing, even if a green line is in the same text', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const outcome = await run(`${green('alpha-news')}\n${ALERT('alpha-news')}\n`);
    expect(outcome).toEqual({ recorded: false, why: 'red-proof' });
    expect(await statusOf(TENANT_A)).toBe('requested');
  });

  it('control case: a green line that is not the command’s own words records nothing', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    for (const text of [
      'erase_tenant_backup_identity: alpha-news: proof green',
      'erase_tenant_backup_identity: alpha-news: proof green: all gone',
      `erase_tenant_backup_identity: alpha-news: ${PROOF_GREEN_TEXT} and more`,
      `${green('alpha-news')} `,
      ` ${green('alpha-news')}`,
      `erase_tenant_backup_identity: ALPHA-NEWS: ${PROOF_GREEN_TEXT}`,
      `x erase_tenant_backup_identity: alpha-news: ${PROOF_GREEN_TEXT}`,
      '',
    ]) {
      expect(await run(text)).toEqual({ recorded: false, why: 'no-green-proof' });
    }
    expect(await statusOf(TENANT_A)).toBe('requested');
  });

  it('control case: text naming two tenants is not one run and records neither', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await tenant.requestOwnErasure(bindTenant(TENANT_B));
    const outcome = await run(`${green('alpha-news')}\n${green('beta-post')}\n`);
    expect(outcome).toEqual({ recorded: false, why: 'more-than-one-tenant' });
    expect(await statusOf(TENANT_A)).toBe('requested');
    expect(await statusOf(TENANT_B)).toBe('requested');
  });

  it('control case: a tenant the register does not name records nothing', async () => {
    const pending = run(`${green('nobody-here')}\n`);
    expect(await pending).toEqual({ recorded: false, why: 'unknown-tenant' });
    expect(pending.lines).toEqual(['erasure: nobody-here: not recorded: unknown-tenant']);
  });

  it('control case: a tenant that never asked cannot be recorded as erased, and gets no row', async () => {
    expect(await run(`${green('alpha-news')}\n`)).toEqual({
      recorded: false,
      why: 'no-request-waiting',
    });
    expect(await fixture.adminDb.select().from(tenantErasureRequest)).toHaveLength(0);
  });

  it('a second run for the same tenant records nothing and leaves the first moment', async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await run(`${green('alpha-news')}\n`);
    const first = await tenant.ownErasure(bindTenant(TENANT_A));
    expect(await run(`${green('alpha-news')}\n`)).toEqual({
      recorded: false,
      why: 'no-request-waiting',
    });
    expect(await tenant.ownErasure(bindTenant(TENANT_A))).toEqual(first);
  });

  it("recording tenant A's key leaves tenant B's request waiting", async () => {
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await tenant.requestOwnErasure(bindTenant(TENANT_B));
    await run(`${green('alpha-news')}\n`);
    expect(await statusOf(TENANT_B)).toBe('requested');
  });

  it('a write that fails is reported as failed, never as recorded', async () => {
    const sink: ErasureSink = {
      listTenantSlugs: () => owner.listTenantSlugs(),
      recordKeyDestroyed: () => Promise.reject(new Error('connection refused to somewhere')),
    };
    const pending = run(`${green('alpha-news')}\n`, sink);
    expect(await pending).toEqual({ recorded: false, why: 'write-failed' });
    expect(pending.lines.join('\n')).not.toContain('somewhere');
  });
});

describe('the proof text is the erase command’s own', () => {
  it('the command prints this green line, word for word, from this module’s constant', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          '../../../infra/provisioning/scripts/erase_tenant_backup_identity.py',
          import.meta.url
        )
      ),
      'utf8'
    );
    // The command writes the line as adjacent string literals; join them as Python does.
    const joined = source.replace(/"\s*\n\s*"/g, '');
    expect(joined).toContain(PROOF_GREEN_TEXT);
    expect(joined).toContain('f"{tenant}: ' + PROOF_GREEN_TEXT);
    expect(source).toContain('erase_tenant_backup_identity: ALERT: ');
  });
});

describe('sabotage: the recorder records only what the command proved', () => {
  interface RecordModule {
    readonly recordKeyDestruction: typeof recordKeyDestruction;
  }

  it('RED: a recorder that ignores an ALERT line records a red run, GREEN: the real one does not', async () => {
    const broken = await importSabotaged<RecordModule>(
      'record-ignores-alert',
      "if (lines.some((line) => line.startsWith(ALERT))) return refuse('red-proof');",
      '',
      'erasure/record.ts'
    );
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const text = `${green('alpha-news')}\n${ALERT('alpha-news')}\n`;
    const red = await broken.recordKeyDestruction(owner, text, () => undefined);
    expect(red).toEqual({ recorded: true, slug: 'alpha-news' });
    expect(await statusOf(TENANT_A)).toBe('key_destroyed');

    await fixture.adminDb.delete(tenantErasureRequest);
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    expect(await run(text)).toEqual({ recorded: false, why: 'red-proof' });
    expect(await statusOf(TENANT_A)).toBe('requested');
  });

  it('RED: a recorder that takes “nothing to erase” as a proof records an unproven key, GREEN: the real one does not', async () => {
    const broken = await importSabotaged<RecordModule>(
      'record-nothing-is-proof',
      'const match = GREEN_LINE.exec(line);',
      'const match = /^erase_tenant_backup_identity: ([a-z0-9-]+): no copy of its backup identity was present; nothing to erase$/.exec(line);',
      'erasure/record.ts'
    );
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    const text = `${NOTHING('alpha-news')}\n`;
    expect(await broken.recordKeyDestruction(owner, text, () => undefined)).toEqual({
      recorded: true,
      slug: 'alpha-news',
    });
    await fixture.adminDb.delete(tenantErasureRequest);
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    expect(await run(text)).toEqual({ recorded: false, why: 'no-green-proof' });
    expect(await statusOf(TENANT_A)).toBe('requested');
  });

  it('RED: a recorder that takes the first of several tenants records one of two, GREEN: the real one records neither', async () => {
    const broken = await importSabotaged<RecordModule>(
      'record-first-of-many',
      "if (green.size > 1) return refuse('more-than-one-tenant');",
      '',
      'erasure/record.ts'
    );
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await tenant.requestOwnErasure(bindTenant(TENANT_B));
    const text = `${green('alpha-news')}\n${green('beta-post')}\n`;
    const red = await broken.recordKeyDestruction(owner, text, () => undefined);
    expect(red.recorded).toBe(true);
    await fixture.adminDb.delete(tenantErasureRequest);
    await tenant.requestOwnErasure(bindTenant(TENANT_A));
    await tenant.requestOwnErasure(bindTenant(TENANT_B));
    expect(await run(text)).toEqual({ recorded: false, why: 'more-than-one-tenant' });
    expect(await statusOf(TENANT_A)).toBe('requested');
    expect(await statusOf(TENANT_B)).toBe('requested');
  });
});
