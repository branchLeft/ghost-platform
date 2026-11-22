import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { TenantDb, bindTenant } from 'ghost-platform-portal-data/tenant';
import { createFixture, TENANT_A, TENANT_B, type Fixture } from '../../data/test/helpers.js';
import { deleteReadings, readingCount } from '../../data/test/healthAdmin.js';
import { nameTenant } from '../../data/test/supportAccessAdmin.js';
import { collectHealth } from '../src/collector/healthCollect.js';
import {
  DRAINED,
  NOT_A_SCRAPE,
  NOW,
  UNDRAINED_MATCHING,
  UNDRAINED_MISMATCHED,
  report,
} from './healthText.js';

// The collector against the real owner role and the real table: a report goes
// in, and what the tenant's own page reads comes out. Tenant A and B are the
// fixture's; they are given placeholder names so the report can find them.
let fixture: Fixture;
let owner: OwnerDb;
let tenant: TenantDb;

const NAME_A = 'placeholder-alpha';
const NAME_B = 'placeholder-bravo';

beforeAll(async () => {
  fixture = await createFixture();
  owner = new OwnerDb(fixture.owner);
  tenant = new TenantDb(fixture.tenant);
  await nameTenant(fixture, TENANT_A, NAME_A);
  await nameTenant(fixture, TENANT_B, NAME_B);
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await deleteReadings(fixture);
});

const lines: string[] = [];
const collect = (text: string) =>
  collectHealth({ sink: owner, report: text, now: NOW, log: (line) => lines.push(line) });
const pageRead = (tenantId: string) => tenant.ownHealth(bindTenant(tenantId));

describe('a report written through the owner role, read back as the tenant page reads it', () => {
  it('shows the undrained colour version and its match, and ignores the drained colour', async () => {
    const summary = await collect(
      report([
        [NAME_A, [DRAINED, UNDRAINED_MATCHING]],
        [NAME_B, [UNDRAINED_MISMATCHED, DRAINED]],
      ])
    );
    expect(summary).toEqual({ accepted: true, recorded: 2, unknown: 0, leftOut: 0, failed: 0 });
    expect(await pageRead(TENANT_A)).toMatchObject({
      health: 'healthy',
      reportedVersion: '6.55.0',
      versionMatch: true,
      mismatchSince: null,
      observedAt: NOW,
    });
    expect(await pageRead(TENANT_B)).toMatchObject({
      health: 'healthy',
      versionMatch: false,
      mismatchSince: NOW,
    });
  });

  it('replaces a healthy reading with unknown when a colour cannot be read, never leaving the old one to show', async () => {
    await collect(report([[NAME_A, [UNDRAINED_MATCHING]]]));
    expect((await pageRead(TENANT_A))?.health).toBe('healthy');

    await collect(report([[NAME_A, [null]]]));
    expect(await pageRead(TENANT_A)).toMatchObject({
      health: 'unknown',
      reportedVersion: null,
      versionMatch: null,
    });

    await collect(report([[NAME_A, [NOT_A_SCRAPE]]]));
    expect((await pageRead(TENANT_A))?.health).toBe('unknown');
  });

  it('shows no reading for a tenant the report did not name', async () => {
    await collect(report([[NAME_A, [UNDRAINED_MATCHING]]]));
    expect(await pageRead(TENANT_B)).toBeNull();
  });

  it('writes nothing for a stranger or a report that is not the contract', async () => {
    await collect(report([['placeholder-stranger', [UNDRAINED_MATCHING]]]));
    await collect('not json');
    expect(await readingCount(fixture)).toBe(0);
  });

  it('keeps the log to the tenant name and the outcome', async () => {
    lines.length = 0;
    await collect(report([[NAME_A, [UNDRAINED_MATCHING, null]]]));
    const log = lines.join('\n');
    expect(log).toContain(`health: ${NAME_A}: recorded unknown: a colour was not read`);
    expect(log).not.toContain(TENANT_A);
    expect(log).not.toContain('6.55.0');
  });
});
