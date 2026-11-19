import { afterEach, describe, expect, it } from 'vitest';
import {
  TunnelAddressError,
  createTunnelBroker,
  type DemoBroker,
} from '../../src/controlPlaneDemoBroker.js';
import { descriptorForSlot } from '../helpers/fixtures.js';
import { controllableHealth, SLOT, tunnelTo } from '../helpers/demoProvisionRig.js';
import { generateTestKeyPair } from '../helpers/signer.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

let broker: TestBroker | undefined;
afterEach(async () => {
  await broker?.close();
  broker = undefined;
});

async function started(): Promise<{ broker: TestBroker; tunnel: DemoBroker }> {
  const health = controllableHealth();
  broker = await startTestBroker({ wrapDeps: (deps) => ({ ...deps, healthChecker: health }) });
  return { broker, tunnel: tunnelTo(broker) };
}

describe('createTunnelBroker', () => {
  it('signs a reconcile the broker verifies, and reads its colour', async () => {
    const { tunnel } = await started();
    expect(await tunnel.reconcile(SLOT, descriptorForSlot(SLOT))).toEqual({
      kind: 'running',
      colour: 'a',
    });
  });

  it('reads status as the phase and the colour health, and nothing else', async () => {
    const { tunnel } = await started();
    expect(await tunnel.status(SLOT)).toEqual({ phase: 'free', healthy: false });
    await tunnel.reconcile(SLOT, descriptorForSlot(SLOT));
    expect(await tunnel.status(SLOT)).toEqual({ phase: 'running', healthy: true });
  });

  it('resets a slot to free, and says so', async () => {
    const { tunnel } = await started();
    await tunnel.reconcile(SLOT, descriptorForSlot(SLOT));
    expect(await tunnel.reset(SLOT)).toBe('free');
    expect(await tunnel.status(SLOT)).toMatchObject({ phase: 'free' });
  });

  it('a request signed with a key the broker does not know is refused, with no body read into the reply', async () => {
    const { broker: b } = await started();
    const stranger = createTunnelBroker({
      baseUrl: b.baseUrl,
      privateKeyRaw: generateTestKeyPair().privateKeyRaw,
      nowSeconds: () => Math.floor(b.nowMs() / 1000),
    });
    expect(await stranger.reconcile(SLOT, descriptorForSlot(SLOT))).toEqual({
      kind: 'refused',
      status: 401,
    });
    expect(await stranger.reset(SLOT)).toBe('refused');
  });

  it('a stale timestamp is refused by the replay window', async () => {
    const { broker: b } = await started();
    const stale = createTunnelBroker({
      baseUrl: b.baseUrl,
      privateKeyRaw: b.keyPair.privateKeyRaw,
      nowSeconds: () => Math.floor(b.nowMs() / 1000) - 3600,
    });
    expect(await stale.reconcile(SLOT, descriptorForSlot(SLOT))).toMatchObject({ kind: 'refused' });
  });

  it('answers unanswered, never throws, when nothing is listening or the call times out', async () => {
    const down = createTunnelBroker({
      baseUrl: 'http://127.0.0.1:1',
      privateKeyRaw: generateTestKeyPair().privateKeyRaw,
      timeoutMs: 500,
    });
    expect(await down.reconcile(SLOT, descriptorForSlot(SLOT))).toEqual({ kind: 'unanswered' });
    expect(await down.reset(SLOT)).toBe('unanswered');
    expect(await down.status(SLOT)).toBeUndefined();
  });

  it('does not take a 200 that is not the documented answer for a success', async () => {
    const odd = createTunnelBroker({
      baseUrl: 'http://127.0.0.1:8090',
      privateKeyRaw: generateTestKeyPair().privateKeyRaw,
      fetch: async () =>
        new Response(JSON.stringify({ slot: '1', phase: 'running' }), { status: 200 }),
    });
    expect(await odd.reconcile(SLOT, descriptorForSlot(SLOT))).toEqual({
      kind: 'refused',
      status: 200,
    });
  });

  it('reads a malformed or refused status as no answer', async () => {
    for (const answer of [
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify({ phase: 'running' }), { status: 200 }),
      new Response('{}', { status: 404 }),
    ]) {
      const tunnel = createTunnelBroker({
        baseUrl: 'http://127.0.0.1:8090',
        privateKeyRaw: generateTestKeyPair().privateKeyRaw,
        fetch: async () => answer.clone(),
      });
      expect(await tunnel.status(SLOT)).toBeUndefined();
    }
  });

  it('never sends a signing key to an address a public resolver could answer', () => {
    const key = generateTestKeyPair().privateKeyRaw;
    for (const baseUrl of [
      'https://broker.example.com',
      'http://8.8.8.8:8090',
      'ftp://127.0.0.1',
      'not a url',
      'http://172.32.0.1',
    ]) {
      expect(() => createTunnelBroker({ baseUrl, privateKeyRaw: key })).toThrow(TunnelAddressError);
    }
    for (const baseUrl of [
      'http://127.0.0.1:8090',
      'http://localhost:8090/',
      'http://[::1]:8090',
      'http://10.20.1.5:8090',
      'http://172.17.0.1:8090',
      'http://192.168.1.2:8090',
    ]) {
      expect(() => createTunnelBroker({ baseUrl, privateKeyRaw: key })).not.toThrow();
    }
  });
});
