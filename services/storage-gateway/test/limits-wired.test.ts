import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUCKET,
  call,
  nextFolder,
  startRig,
  type Minted,
  type Rig,
  type SignedCall,
} from './support/gateway-rig.js';

// The rate limit and the write kill switches, driven through the real service:
// a unit test of the gate proves the gate, only this proves the service asks it.

const OBJECT = (folder: string, name: string): string => `/${BUCKET}/${folder}/${name}`;

const get = (rig: Rig, who: Minted, name: string) =>
  rig.s3(who, { method: 'GET', path: OBJECT(who.folder, name) });
const put = (rig: Rig, who: Minted, name: string) =>
  rig.s3(who, { method: 'PUT', path: OBJECT(who.folder, name), body: 'bytes' });
const send = (rig: Rig, signed: SignedCall) =>
  call(rig.port, signed.method, signed.target, signed.headers, signed.body || undefined);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-limits-wired-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the per-tenant request rate', () => {
  it('refuses a tenant past its burst with a retryable 503 and still serves every other tenant', async () => {
    const rig = await startRig({
      env: { STORAGE_GATEWAY_TENANT_RATE_PER_SECOND: '1', STORAGE_GATEWAY_TENANT_RATE_BURST: '2' },
    });
    try {
      const noisy = await rig.mint(nextFolder(), 16);
      const quiet = await rig.mint(nextFolder(), 16);
      expect((await get(rig, noisy, 'a.png')).status).toBe(200);
      expect((await get(rig, noisy, 'b.png')).status).toBe(200);
      const refused = await get(rig, noisy, 'c.png');
      expect(refused.status).toBe(503);
      expect(refused.text).toContain('<Code>SlowDown</Code>');
      expect(rig.lines.join('\n')).toContain('"code":"rate-limited"');
      expect((await get(rig, quiet, 'a.png')).status).toBe(200);
      expect((await put(rig, quiet, 'b.png')).status).toBe(200);
    } finally {
      await rig.stop();
    }
  });

  it('is not spent by a replayed request, so a captured request cannot drain a tenant', async () => {
    const rig = await startRig({
      env: { STORAGE_GATEWAY_TENANT_RATE_PER_SECOND: '1', STORAGE_GATEWAY_TENANT_RATE_BURST: '2' },
    });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      const captured = await rig.sign(tenant, {
        method: 'GET',
        path: OBJECT(tenant.folder, 'captured.png'),
      });
      expect((await send(rig, captured)).status).toBe(200);
      for (let i = 0; i < 5; i += 1) expect((await send(rig, captured)).status).toBe(403);
      // One allowance is left: the five replays took none.
      expect((await get(rig, tenant, 'fresh.png')).status).toBe(200);
    } finally {
      await rig.stop();
    }
  });

  it('is spent by nothing on a request that never verified', async () => {
    const rig = await startRig({
      env: { STORAGE_GATEWAY_TENANT_RATE_PER_SECOND: '1', STORAGE_GATEWAY_TENANT_RATE_BURST: '2' },
    });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      for (let i = 0; i < 5; i += 1) {
        const forged = await rig.sign(
          tenant,
          { method: 'GET', path: OBJECT(tenant.folder, `forged${i}.png`) },
          (h) => ({
            ...h,
            authorization:
              h.authorization?.replace(/Signature=[0-9a-f]{64}$/, `Signature=${'0'.repeat(64)}`) ??
              '',
          })
        );
        expect((await send(rig, forged)).status).toBe(403);
      }
      expect((await get(rig, tenant, 'a.png')).status).toBe(200);
      expect((await get(rig, tenant, 'b.png')).status).toBe(200);
    } finally {
      await rig.stop();
    }
  });
});

describe('a gate that fails', () => {
  it('refuses the request with a retryable 503 and sends nothing upstream, never serving it unchecked', async () => {
    const rig = await startRig({
      limits: {
        check: () => {
          throw new Error('limit store down');
        },
      },
    });
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      for (const answer of [await get(rig, tenant, 'a.png'), await put(rig, tenant, 'b.png')]) {
        expect(answer.status).toBe(503);
        expect(answer.text).toContain('<Code>ServiceUnavailable</Code>');
      }
      expect(rig.upstream.seen).toEqual([]);
      expect(rig.lines.join('\n')).toContain('"code":"internal-error"');
    } finally {
      await rig.stop();
    }
  });
});

describe('the write kill switches', () => {
  it('stops one tenant writing, leaves its reads and every other tenant alone, and lifts again', async () => {
    const rig = await startRig();
    try {
      const stopped = await rig.mint(nextFolder(), 16);
      const other = await rig.mint(nextFolder(), 16);
      rig.gateway.switches.setTenant(stopped.keyId, true);

      const refused = await put(rig, stopped, 'w.png');
      expect(refused.status).toBe(503);
      expect(rig.lines.join('\n')).toContain('"code":"writes-disabled"');
      const before = rig.upstream.seen.length;
      expect(rig.upstream.seen.filter((s) => s.method === 'PUT')).toHaveLength(0);
      expect((await get(rig, stopped, 'r.png')).status).toBe(200);
      expect((await put(rig, other, 'w.png')).status).toBe(200);
      expect(rig.upstream.seen.length - before).toBe(2);

      rig.gateway.switches.setTenant(stopped.keyId, false);
      expect((await put(rig, stopped, 'w2.png')).status).toBe(200);
    } finally {
      await rig.stop();
    }
  });

  it('stops every tenant writing under the global switch, and refuses a multipart create too', async () => {
    const rig = await startRig();
    try {
      const a = await rig.mint(nextFolder(), 16);
      const b = await rig.mint(nextFolder(), 16);
      rig.gateway.switches.setGlobal(true);
      for (const who of [a, b]) {
        expect((await put(rig, who, 'w.png')).status).toBe(503);
        const create = await rig.s3(who, {
          method: 'POST',
          path: OBJECT(who.folder, 'm.bin'),
          query: { uploads: '' },
        });
        expect(create.status).toBe(503);
        expect((await get(rig, who, 'r.png')).status).toBe(200);
      }
      expect(rig.upstream.seen.every((s) => s.method === 'GET')).toBe(true);
    } finally {
      await rig.stop();
    }
  });

  it('gives a refused write back its signature, so the same request goes through once the switch is lifted', async () => {
    const rig = await startRig();
    try {
      const tenant = await rig.mint(nextFolder(), 16);
      rig.gateway.switches.setTenant(tenant.keyId, true);
      const signed = await rig.sign(tenant, {
        method: 'PUT',
        path: OBJECT(tenant.folder, 'again.png'),
        body: 'bytes',
      });
      expect((await send(rig, signed)).status).toBe(503);
      rig.gateway.switches.setTenant(tenant.keyId, false);
      expect((await send(rig, signed)).status).toBe(200);
    } finally {
      await rig.stop();
    }
  });

  it('keeps a switch across a restart when a switch file is set, and refuses to start on a damaged one', async () => {
    const file = join(dir, 'switches.json');
    const first = await startRig({ env: { STORAGE_GATEWAY_WRITE_SWITCHES_FILE: file } });
    let keyId: string;
    try {
      const tenant = await first.mint(nextFolder(), 16);
      keyId = tenant.keyId;
      first.gateway.switches.setTenant(keyId, true);
      first.gateway.switches.setGlobal(true);
    } finally {
      await first.stop();
    }
    const second = await startRig({ env: { STORAGE_GATEWAY_WRITE_SWITCHES_FILE: file } });
    try {
      expect(second.gateway.switches.state()).toEqual({ global: true, tenants: [keyId] });
    } finally {
      await second.stop();
    }

    await writeFile(file, '{ not json');
    await expect(
      startRig({ env: { STORAGE_GATEWAY_WRITE_SWITCHES_FILE: file } })
    ).rejects.toThrow();
  });
});
