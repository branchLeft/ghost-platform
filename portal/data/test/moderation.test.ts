import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  COMMENT_CHECKS,
  InvalidSettingError,
  TenantDb,
  UnknownCheckError,
  bindTenant,
} from '../src/tenant/index.js';
import { connect } from '../src/db.js';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import * as schema from '../src/schema.js';
import { TENANT_A, TENANT_B, createFixture, type Fixture } from './helpers.js';

const NOW = new Date('2026-10-12T10:00:00Z');
const LATER = new Date('2026-10-12T11:00:00Z');

let fixture: Fixture;
let tenant: TenantDb;
const scopeA = bindTenant(TENANT_A);
const scopeB = bindTenant(TENANT_B);

const all = (enabled: boolean, sensitivity: string) =>
  COMMENT_CHECKS.map((check) => ({ check, enabled, sensitivity }));

beforeAll(async () => {
  fixture = await createFixture();
  tenant = new TenantDb(fixture.tenant);
});

afterAll(async () => {
  await fixture.close();
});

const rowCount = async (): Promise<number> =>
  (await fixture.adminDb.select().from(schema.moderationSetting)).length;

describe('the moderation settings table', () => {
  it('is covered by the isolation check', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });

  it('holds nothing for a tenant that has saved nothing', async () => {
    expect(await tenant.moderationSettings(scopeA)).toEqual({});
  });
});

describe('saving comment-check settings', () => {
  it('saves and reads back each check for the bound tenant alone', async () => {
    await tenant.saveModerationSettings(
      scopeA,
      {
        changes: [
          { check: 'spam', enabled: false, sensitivity: 'high' },
          { check: 'harassment', enabled: true, sensitivity: 'low' },
        ],
        updatedBy: 'user-a',
      },
      NOW
    );
    expect(await tenant.moderationSettings(scopeA)).toEqual({
      spam: { enabled: false, sensitivity: 'high' },
      harassment: { enabled: true, sensitivity: 'low' },
    });
    expect(await tenant.moderationSettings(scopeB)).toEqual({});
  });

  it('replaces a saved check in place and records who and when', async () => {
    await tenant.saveModerationSettings(
      scopeA,
      { changes: [{ check: 'spam', enabled: true, sensitivity: 'medium' }], updatedBy: 'user-a2' },
      LATER
    );
    expect((await tenant.moderationSettings(scopeA))['spam']).toEqual({
      enabled: true,
      sensitivity: 'medium',
    });
    const rows = await fixture.adminDb
      .select()
      .from(schema.moderationSetting)
      .where(
        and(
          eq(schema.moderationSetting.tenantId, TENANT_A),
          eq(schema.moderationSetting.checkId, 'spam')
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('user-a2');
    expect(rows[0]?.updatedAt.toISOString()).toBe(LATER.toISOString());
  });

  it('keeps one tenant out of another tenant row whatever the request holds', async () => {
    await tenant.saveModerationSettings(
      scopeB,
      { changes: all(false, 'low'), updatedBy: 'user-b' },
      NOW
    );
    const a = await tenant.moderationSettings(scopeA);
    expect(a['spam']).toEqual({ enabled: true, sensitivity: 'medium' });
    const b = await tenant.moderationSettings(scopeB);
    for (const check of COMMENT_CHECKS) {
      expect(b[check]).toEqual({ enabled: false, sensitivity: 'low' });
    }
  });
});

describe('the closed list of checks (control case)', () => {
  const before = async () => ({
    a: await tenant.moderationSettings(scopeA),
    n: await rowCount(),
  });

  it.each([
    ['threats'],
    ['incitement'],
    ['targeting_package'],
    ['csam_text'],
    ['media_hash'],
    ['not_a_check'],
    [''],
    ['SPAM'],
    ['__proto__'],
  ])('refuses %j with a typed error and writes nothing, even beside a valid change', async (id) => {
    const snapshot = await before();
    await expect(
      tenant.saveModerationSettings(
        scopeA,
        {
          changes: [
            { check: 'off_topic', enabled: false, sensitivity: 'high' },
            { check: id, enabled: false, sensitivity: 'low' },
          ],
          updatedBy: 'user-a',
        },
        NOW
      )
    ).rejects.toBeInstanceOf(UnknownCheckError);
    expect(await before()).toEqual(snapshot);
  });

  it('carries the refused check on the error', async () => {
    await expect(
      tenant.saveModerationSettings(
        scopeA,
        { changes: [{ check: 'threats', enabled: false, sensitivity: 'low' }], updatedBy: 'u' },
        NOW
      )
    ).rejects.toMatchObject({ name: 'UnknownCheckError', check: 'threats' });
  });

  it('refuses a sensitivity outside the closed list, a repeated check and an empty request', async () => {
    const snapshot = await before();
    const bad = [
      [{ check: 'spam', enabled: true, sensitivity: 'off' }],
      [{ check: 'spam', enabled: true, sensitivity: '' }],
      [
        { check: 'spam', enabled: true, sensitivity: 'low' },
        { check: 'spam', enabled: false, sensitivity: 'high' },
      ],
      [],
    ];
    for (const changes of bad) {
      await expect(
        tenant.saveModerationSettings(scopeA, { changes, updatedBy: 'u' }, NOW)
      ).rejects.toBeInstanceOf(InvalidSettingError);
    }
    expect(await before()).toEqual(snapshot);
  });
});

describe('the database refuses what the code would have refused', () => {
  it('rejects a floor check written straight through the tenant role', async () => {
    await expect(
      tenant.run(scopeA, (tx) =>
        tx.insert(schema.moderationSetting).values({
          tenantId: scopeA.tenantId,
          checkId: 'threats' as never,
          enabled: false,
          sensitivity: 'low',
          updatedBy: 'u',
          updatedAt: NOW,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects an update that renames a saved check to a floor check', async () => {
    await expect(
      tenant.run(scopeA, (tx) =>
        tx
          .update(schema.moderationSetting)
          .set({ checkId: 'csam_text' as never })
          .where(
            and(
              eq(schema.moderationSetting.tenantId, scopeA.tenantId),
              eq(schema.moderationSetting.checkId, 'spam')
            )
          )
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects a row for another tenant', async () => {
    await expect(
      tenant.run(scopeA, (tx) =>
        tx.insert(schema.moderationSetting).values({
          tenantId: scopeB.tenantId,
          checkId: 'self_harm',
          enabled: false,
          sensitivity: 'low',
          updatedBy: 'u',
          updatedAt: NOW,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('holds no delete privilege for the tenant role', async () => {
    await expect(
      tenant.run(scopeA, (tx) =>
        tx.delete(schema.moderationSetting).where(eq(schema.moderationSetting.tenantId, TENANT_A))
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('shows the tenant role no row without a bound tenant', async () => {
    // A bare login session, with no SET ROLE and no binding, holds nothing in the schema.
    const bare = connect(fixture.tenant).select().from(schema.moderationSetting);
    await expect(bare).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
