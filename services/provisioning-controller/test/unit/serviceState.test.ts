import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { raw } from '../support/mockHarness.js';
import {
  DEMO_A,
  OWNER_CREDENTIAL,
  TENANT_A,
  TENANT_A_CREDENTIAL,
  TENANT_B,
  TENANT_B_CREDENTIAL,
  demoRegister,
  makeRig,
  type Rig,
} from '../support/serviceHarness.js';
import { StateFileError } from '../../src/service/stateFile.js';
import { readDemoRegister } from '../../src/service/demoRegister.js';

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(async () => {
  await rig.cleanup();
});

const t = (credential: string): Record<string, string> => ({ 'x-tenant-credential': credential });
const o = (): Record<string, string> => ({ 'x-owner-credential': OWNER_CREDENTIAL });
const JSON_HEADER = { 'content-type': 'application/json' };
const ask = (tier: string): string => JSON.stringify({ tier });

describe('the real service keeps what it was told', () => {
  it('walks the journey and keeps every answer across a restart', async () => {
    const first = await rig.start();
    const demo = await raw(first.baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(demo.json).toMatchObject({
      demo_id: DEMO_A,
      state: 'LIVE',
      address: 'demo.example.test',
    });

    const made = await raw(first.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    expect(made.status).toBe(201);
    const request = made.json as { request_id: string; state: string };
    expect(request.state).toBe('pending');

    const approved = await raw(
      first.baseUrl,
      'POST',
      `/promotion-requests/${request.request_id}/approve`,
      {
        headers: o(),
      }
    );
    expect(approved.status).toBe(200);
    await first.close();

    const second = await rig.start();
    const again = await raw(
      second.baseUrl,
      'POST',
      `/promotion-requests/${request.request_id}/approve`,
      {
        headers: o(),
      }
    );
    expect([again.status, again.json]).toEqual([200, approved.json]);
    const tenant = await raw(second.baseUrl, 'GET', `/tenants/${TENANT_A}`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(tenant.json).toEqual({
      tenant_id: TENANT_A,
      tier: 'essentials',
      state: 'provisioning',
      invoice_ref: null,
      hostnames: ['demo.example.test'],
    });
    const listed = await raw(second.baseUrl, 'GET', '/promotion-requests?state=pending', {
      headers: o(),
    });
    expect(listed.json).toEqual({ items: [] });
  });

  it('a second approve changes nothing: the same body, status and ledger', async () => {
    const running = await rig.start();
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    const id = (made.json as { request_id: string }).request_id;
    const one = await raw(running.baseUrl, 'POST', `/promotion-requests/${id}/approve`, {
      headers: o(),
    });
    const stateAfterOne = readFileSync(join(rig.files.state, 'state.json'), 'utf8');
    const two = await raw(running.baseUrl, 'POST', `/promotion-requests/${id}/approve`, {
      headers: o(),
    });
    expect([two.status, two.json]).toEqual([one.status, one.json]);
    expect(readFileSync(join(rig.files.state, 'state.json'), 'utf8')).toBe(stateAfterOne);
  });

  it('writes the approval where the controller reads approvals, as one entry', async () => {
    const running = await rig.start();
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_B}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_B_CREDENTIAL) },
      body: ask('essentials'),
    });
    const id = (made.json as { request_id: string }).request_id;
    const approved = await raw(running.baseUrl, 'POST', `/promotion-requests/${id}/approve`, {
      headers: o(),
    });
    const approval = (approved.json as { approval: { approval_id: string; approved_at: string } })
      .approval;
    const ledger = JSON.parse(
      readFileSync(join(rig.files.state, 'approvals.json'), 'utf8')
    ) as unknown;
    expect(ledger).toEqual({
      approvals: [
        {
          approvalId: approval.approval_id,
          tenantId: TENANT_B,
          approvedAt: approval.approved_at,
          scopes: ['setup', 'web-address', 'first-deploy'],
        },
      ],
    });
    const { FileApprovalLedger } = await import('../../src/fileReaders.js');
    chmodSync(join(rig.files.state, 'approvals.json'), 0o600);
    const found = await new FileApprovalLedger(join(rig.files.state, 'approvals.json')).find(
      approval.approval_id
    );
    expect(found?.tenantId).toBe(TENANT_B);
  });

  it('a professional enquiry is listed and cannot be approved', async () => {
    const running = await rig.start();
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('professional-enquiry'),
    });
    const id = (made.json as { request_id: string }).request_id;
    const refused = await raw(running.baseUrl, 'POST', `/promotion-requests/${id}/approve`, {
      headers: o(),
    });
    expect([refused.status, refused.json]).toEqual([409, { code: 'not-approvable' }]);
  });

  it('refuses to start on damaged state, and on state other users can read', async () => {
    const running = await rig.start();
    await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    await running.close();
    const path = join(rig.files.state, 'state.json');
    chmodSync(path, 0o644);
    await expect(rig.start()).rejects.toThrow(StateFileError);
    chmodSync(path, 0o600);
    writeFileSync(path, '{"version":2}');
    await expect(rig.start()).rejects.toThrow(StateFileError);
    writeFileSync(path, 'not json');
    await expect(rig.start()).rejects.toThrow(StateFileError);
    rmSync(path);
    symlinkSync(rig.files.demos, path);
    await expect(rig.start()).rejects.toThrow(StateFileError);
  });

  it('a write that fails refuses the call and records nothing', async () => {
    const running = await rig.start();
    // A directory where the temporary file must go makes the write throw.
    mkdirSync(rig.files.state, { recursive: true });
    mkdirSync(join(rig.files.state, `state.json.${String(process.pid)}.tmp`));
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    expect(made.status).toBe(500);
    rmSync(join(rig.files.state, `state.json.${String(process.pid)}.tmp`), { recursive: true });
    const listed = await raw(running.baseUrl, 'GET', '/promotion-requests', { headers: o() });
    expect(listed.json).toEqual({ items: [] });
    const retried = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    expect(retried.status).toBe(201);
  });

  it('a failed approval write undoes the approval and the tenant stays a demo', async () => {
    const running = await rig.start();
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    const id = (made.json as { request_id: string }).request_id;
    mkdirSync(join(rig.files.state, `state.json.${String(process.pid)}.tmp`));
    const failed = await raw(running.baseUrl, 'POST', `/promotion-requests/${id}/approve`, {
      headers: o(),
    });
    expect(failed.status).toBe(500);
    const tenant = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(tenant.json).toMatchObject({ tier: 'demo', state: 'live' });
    const pending = await raw(running.baseUrl, 'GET', '/promotion-requests?state=pending', {
      headers: o(),
    });
    expect((pending.json as { items: unknown[] }).items).toHaveLength(1);
  });

  it('an unwritable approvals ledger does not refuse the approval, and is reported', async () => {
    const running = await rig.start();
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    const id = (made.json as { request_id: string }).request_id;
    mkdirSync(join(rig.files.state, `approvals.json.${String(process.pid)}.tmp`));
    const approved = await raw(running.baseUrl, 'POST', `/promotion-requests/${id}/approve`, {
      headers: o(),
    });
    expect(approved.status).toBe(200);
    expect(rig.problems).toContain('approvals-ledger-not-written');
  });
});

describe('the register of demos decides which tenants exist', () => {
  it('a tenant the register does not name has no demo, and one added later appears with no restart', async () => {
    writeFileSync(rig.files.demos, demoRegister([{ tenantId: TENANT_A, demoId: DEMO_A }]));
    const running = await rig.start();
    const before = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_B}/demo`, {
      headers: t(TENANT_B_CREDENTIAL),
    });
    expect([before.status, before.json]).toEqual([404, { code: 'demo-not-found' }]);
    writeFileSync(
      rig.files.demos,
      demoRegister([
        { tenantId: TENANT_A, demoId: DEMO_A },
        { tenantId: TENANT_B, demoId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      ])
    );
    const after = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_B}/demo`, {
      headers: t(TENANT_B_CREDENTIAL),
    });
    expect(after.status).toBe(200);
  });

  it('a demo that expires in the register is seen, until the tenant is promoted', async () => {
    const running = await rig.start();
    writeFileSync(
      rig.files.demos,
      demoRegister([{ tenantId: TENANT_A, demoId: DEMO_A, state: 'KILLED' }])
    );
    const killed = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(killed.json).toMatchObject({ state: 'KILLED' });
    const refused = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    expect([refused.status, refused.json]).toEqual([409, { code: 'demo-not-promotable' }]);

    writeFileSync(
      rig.files.demos,
      demoRegister([{ tenantId: TENANT_A, demoId: DEMO_A, state: 'EXPIRING' }])
    );
    const made = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_A}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...t(TENANT_A_CREDENTIAL) },
      body: ask('essentials'),
    });
    const id = (made.json as { request_id: string }).request_id;
    await raw(running.baseUrl, 'POST', `/promotion-requests/${id}/approve`, { headers: o() });
    writeFileSync(
      rig.files.demos,
      demoRegister([{ tenantId: TENANT_A, demoId: DEMO_A, state: 'LIVE' }])
    );
    const tenant = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(tenant.json).toMatchObject({ tier: 'essentials', state: 'provisioning' });
    const demo = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(demo.json).toMatchObject({ state: 'PROMOTING' });
  });

  it('an unusable register keeps what is known and is reported by code', async () => {
    const running = await rig.start();
    writeFileSync(rig.files.demos, '{"demos": [{"tenantId": "not-a-uuid"}]}');
    const demo = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(demo.status).toBe(200);
    expect(rig.problems).toContain('demo-register-unusable');
    rmSync(rig.files.demos);
    await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
      headers: t(TENANT_A_CREDENTIAL),
    });
    expect(rig.problems).toContain('demo-register-unreadable');
  });

  it.each([
    ['not JSON', 'nope', 'it is not JSON'],
    [
      'a shape that is not a register',
      '{"demos":[{"tenantId":"x"}]}',
      'it does not have the shape of a register',
    ],
    [
      'a tenant twice',
      demoRegister([
        { tenantId: TENANT_A, demoId: DEMO_A },
        { tenantId: TENANT_A, demoId: DEMO_A },
      ]),
      'a tenant appears twice',
    ],
  ])('the reader refuses %s', (_name, text, problem) => {
    writeFileSync(rig.files.demos, text);
    expect(() => readDemoRegister(rig.files.demos)).toThrow(problem);
  });

  it('the reader refuses a file others can write, a link and a directory', () => {
    chmodSync(rig.files.demos, 0o666);
    expect(() => readDemoRegister(rig.files.demos)).toThrow('other users can write it');
    chmodSync(rig.files.demos, 0o644);
    const link = join(rig.dir, 'link.json');
    symlinkSync(rig.files.demos, link);
    expect(() => readDemoRegister(link)).toThrow('it cannot be opened');
    expect(() => readDemoRegister(rig.dir)).toThrow('it is not a regular file');
    expect(existsSync(rig.files.demos)).toBe(true);
  });
});
