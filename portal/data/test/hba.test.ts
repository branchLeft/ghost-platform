import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judgeHbaRules, probeOtherDatabases, type HbaRule } from '../provision/hba.js';
import { withHba } from './hbaFile.js';
import { resetServer, run, TENANT } from './provisionSetup.js';

// The cross-database control: pg_hba's rules, checked statically, checked for
// drift between the file and what the server loaded, and probed.

function rule(
  line: number,
  users: string[],
  databases: string[],
  method = 'scram-sha-256'
): HbaRule {
  return { line, file: 'pg_hba.conf', type: 'host', users, databases, method, error: null };
}

const target = {
  database: 'portal',
  logins: [
    { name: 'portal_tenant_login', reaches: ['portal_tenant_login', 'portal_tenant'] },
    { name: 'portal_owner_login', reaches: ['portal_owner_login', 'portal_owner'] },
  ],
};

describe('the static pg_hba rule', () => {
  it('passes the control plane file: portal logins reach portal alone, all else rejected', () => {
    const rules = [
      rule(1, ['postgres'], ['all']),
      rule(2, ['zitadel'], ['zitadel']),
      rule(3, ['portal_tenant_login'], ['portal']),
      rule(4, ['portal_owner_login'], ['portal']),
      rule(5, ['postgres'], ['postgres', 'zitadel', 'portal']),
      rule(6, ['all'], ['all'], 'reject'),
      rule(7, ['all'], ['all'], 'reject'),
    ];
    expect(judgeHbaRules(rules, target)).toEqual([]);
  });

  it.each([
    ['the stock image rule', ['all'], ['all'], /portal_tenant_login \(as all\) reach database all/],
    [
      'a login named with another database',
      ['portal_owner_login'],
      ['postgres'],
      /portal_owner_login .* database postgres/,
    ],
    [
      'a role the login reaches',
      ['+portal_tenant'],
      ['zitadel'],
      /portal_tenant_login \(as \+portal_tenant\)/,
    ],
    [
      'a login reaching itself as a group',
      ['+portal_owner_login'],
      ['all'],
      /portal_owner_login \(as \+portal_owner_login\)/,
    ],
    ['a regular expression', ['/^portal'], ['postgres'], /\(as \/\^portal\)/],
    ['an included file', ['@users'], ['postgres'], /\(as @users\)/],
    ['sameuser', ['portal_tenant_login'], ['sameuser'], /database sameuser/],
    ['replication', ['portal_tenant_login'], ['replication'], /database replication/],
    [
      'the portal database beside another',
      ['portal_tenant_login'],
      ['portal', 'postgres'],
      /database postgres/,
    ],
  ])('refuses %s', (_name, users, databases, pattern) => {
    const problems = judgeHbaRules([rule(9, users, databases)], target);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(pattern);
  });

  it('ignores a group the login does not reach, and every reject rule', () => {
    expect(judgeHbaRules([rule(1, ['+zitadel_group'], ['all'])], target)).toEqual([]);
    expect(judgeHbaRules([rule(1, ['all'], ['all'], 'reject')], target)).toEqual([]);
  });

  it('refuses a rule the server could not parse', () => {
    const broken: HbaRule = { ...rule(3, [], []), error: 'invalid authentication method "trsut"' };
    expect(judgeHbaRules([broken], target)).toEqual([
      'pg_hba rule at pg_hba.conf:3 does not parse: invalid authentication method "trsut"',
    ]);
  });
});

describe('the probe of the loaded rules', () => {
  it('accepts only the pg_hba refusal, SQLSTATE 28000', async () => {
    const outcomes: Record<string, string> = { a: '28000', b: 'ok', c: '28P01' };
    const problems = await probeOtherDatabases(
      ['a', 'b', 'c'],
      [{ name: 'l', password: 'p' }],
      (database) => Promise.resolve(outcomes[database]!)
    );
    expect(problems).toEqual([
      'login l was not refused by pg_hba at database b (got ok)',
      'login l was not refused by pg_hba at database c (got 28P01)',
    ]);
  });
});

describe('pg_hba drift on a real server', () => {
  if (process.env['PORTAL_TEST_DATABASE_URL'] === undefined) {
    it('needs PORTAL_TEST_DATABASE_URL', () => {
      throw new Error('PORTAL_TEST_DATABASE_URL must name a PostgreSQL superuser connection');
    });
    return;
  }

  beforeAll(async () => {
    await resetServer();
  }, 60000);

  afterAll(async () => {
    await resetServer();
  }, 60000);

  it('refuses a file changed since the server last loaded it', async () => {
    await withHba(
      (original) => original,
      false,
      async () => {
        const result = await run();
        expect(result.code).toBe(1);
        expect(result.err.join('\n')).toMatch(
          /extra M28: pg_hba file .* changed at or after the last configuration load/
        );
      }
    );
  }, 60000);

  it('refuses a rule the server failed to load, though the old rules stay loaded', async () => {
    await withHba(
      (original) => `host all ${TENANT} 127.0.0.1/32 trsut\n${original}`,
      true,
      async () => {
        const result = await run();
        expect(result.code).toBe(1);
        expect(result.err.join('\n')).toMatch(/extra M28: pg_hba rule at .*:1 does not parse/);
      }
    );
  }, 60000);

  it("refuses the stock image's catch-all rule once loaded, whatever its address", async () => {
    await withHba(
      (original) => `host all all 192.0.2.0/24 scram-sha-256\n${original}`,
      true,
      async () => {
        const result = await run();
        expect(result.code).toBe(1);
        expect(result.err.join('\n')).toMatch(
          new RegExp(
            `extra M28: pg_hba rule at .*:1 lets ${TENANT} \\(as all\\) reach database all`
          )
        );
      }
    );
  }, 60000);
});
