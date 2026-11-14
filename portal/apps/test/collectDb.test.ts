import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OwnerDb } from 'ghost-platform-portal-data/owner';
import { TenantDb, bindTenant } from 'ghost-platform-portal-data/tenant';
import { createFixture, TENANT_A, TENANT_B, type Fixture } from '../../data/test/helpers.js';
import { deleteReading, nameTenant, readingRow } from '../../data/test/supportAccessAdmin.js';
import { collectSupportAccess } from '../src/collector/collect.js';
import { at, exporterText, NOW } from './collectorText.js';

// The collector against the real owner role and the real table: a host's text goes in,
// and what the tenant's own page reads comes out. Tenant A and B are the fixture's;
// they are given placeholder names so a host's series can find them.
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
  await deleteReading(fixture, TENANT_A);
  await deleteReading(fixture, TENANT_B);
});

const lines: string[] = [];
const collect = (scrape: string) =>
  collectSupportAccess({ sink: owner, scrape, now: NOW, log: (line) => lines.push(line) });

const pageRead = (tenantId: string) => tenant.ownSupportAccess(bindTenant(tenantId), NOW);

describe('a host text written through the owner role, read back as the tenant page reads it', () => {
  it('shows an open tenant with its deadline and a closed tenant as closed', async () => {
    const summary = await collect(
      exporterText([
        {
          tenant: NAME_A,
          state: 'open',
          lane: 'consented',
          granted: at(-600),
          deadline: at(13800),
          observed: at(-5),
        },
        { tenant: NAME_B, state: 'closed', observed: at(-5) },
      ])
    );
    expect(summary).toEqual({ accepted: true, recorded: 2, leftOut: 0, failed: 0 });
    const a = await pageRead(TENANT_A);
    expect(a.state).toBe('open');
    expect(a.deadline).toEqual(new Date(at(13800) * 1000));
    expect((await pageRead(TENANT_B)).state).toBe('closed');
  });

  it('shows unknown, not closed, for a tenant the host did not report', async () => {
    await collect(exporterText([{ tenant: NAME_A, state: 'closed', observed: at(-5) }]));
    expect((await pageRead(TENANT_A)).state).toBe('closed');
    expect((await pageRead(TENANT_B)).state).toBe('unknown');
  });

  it('writes nothing for an old or a future series, a stranger, or text that is not the contract', async () => {
    for (const scrape of [
      exporterText([{ tenant: NAME_A, state: 'closed', observed: at(-3600) }]),
      exporterText([{ tenant: NAME_A, state: 'closed', observed: at(3600) }]),
      exporterText([{ tenant: 'placeholder-stranger', state: 'closed', observed: at(-5) }]),
      'branchleft_support_access_state garbled\n',
      '',
    ]) {
      await collect(scrape);
    }
    expect(await readingRow(fixture, TENANT_A)).toBeNull();
    expect(await readingRow(fixture, TENANT_B)).toBeNull();
    expect((await pageRead(TENANT_A)).state).toBe('unknown');
  });

  it('replaces the reading on the next run: a revoked grant reads closed', async () => {
    await collect(
      exporterText([{ tenant: NAME_A, state: 'open', deadline: at(900), observed: at(-60) }])
    );
    expect((await pageRead(TENANT_A)).state).toBe('open');
    await collect(exporterText([{ tenant: NAME_A, state: 'closed', observed: at(-1) }]));
    expect((await pageRead(TENANT_A)).state).toBe('closed');
  });

  it('keeps the log to the tenant name and the state', async () => {
    lines.length = 0;
    await collect(
      exporterText([
        {
          tenant: NAME_A,
          state: 'open',
          lane: 'incident',
          granted: at(-60),
          deadline: at(600),
          observed: at(-5),
        },
      ])
    );
    const log = lines.join('\n');
    expect(log).toContain(`support-access: ${NAME_A}: recorded state=open`);
    expect(log).not.toContain(TENANT_A);
    expect(log).not.toContain('incident');
  });
});
