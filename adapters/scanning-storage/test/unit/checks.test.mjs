import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createPdqKnownMaterialCheck,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HASH_TIMEOUT_MS,
  NO_HASH_SOURCE,
} = require('../../src/checks.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');

// The content digest and the verdict key are different strings on purpose,
// so a test can tell which of the two a value came from.
const computeDigest = (buffer) => `digest-${buffer.toString('hex')}`;
const computeVerdictKey = async (buffer) => ({ hash: `key-${buffer.toString('hex')}` });
const options = { computeDigest, computeVerdictKey };

describe('createPdqKnownMaterialCheck', () => {
  it('declares kind media and blocking true', () => {
    const check = createPdqKnownMaterialCheck(new FakeVerdictClient(), options);
    expect(check.kind).toBe('media');
    expect(check.blocking).toBe(true);
  });

  it('requires a computeDigest function', () => {
    expect(() =>
      createPdqKnownMaterialCheck(new FakeVerdictClient(), { computeVerdictKey })
    ).toThrow(/computeDigest/);
  });

  it('requires a computeVerdictKey function, so a stand-in key can never be the default', () => {
    expect(() => createPdqKnownMaterialCheck(new FakeVerdictClient(), { computeDigest })).toThrow(
      /computeVerdictKey/
    );
  });

  it('asks the verdict client about the verdict key, not the content digest', async () => {
    const asked = [];
    const client = {
      async getVerdict(key) {
        asked.push(key);
        return { classification: 'no-known-match', source: 'test' };
      },
    };
    const check = createPdqKnownMaterialCheck(client, options);
    await check.run({ buffer: Buffer.from('ab', 'hex') });
    expect(asked).toEqual(['key-ab']);
  });

  it('files the verdict under the content digest, whatever the client echoes as evidence', async () => {
    const client = new FakeVerdictClient({
      refuse: new Map([['key-626164', { classification: 'csam' }]]),
    });
    const check = createPdqKnownMaterialCheck(client, options);
    const verdict = await check.run({ buffer: Buffer.from('bad') });
    expect(verdict.classification).toBe('csam');
    expect(verdict.evidence).toBe('digest-626164');
    expect(verdict.verdictKey).toBe('key-626164');
  });

  it('never throws: a verdict client that rejects resolves to an unavailable verdict', async () => {
    const client = {
      async getVerdict() {
        throw new Error('channel unreachable');
      },
    };
    const check = createPdqKnownMaterialCheck(client, options);
    const verdict = await check.run({ buffer: Buffer.from('anything') });
    expect(verdict.classification).toBe('unavailable');
    expect(verdict.evidence).toBe(computeDigest(Buffer.from('anything')));
  });

  it('never throws: a verdict client slower than the budget resolves to unavailable instead of hanging', async () => {
    const client = { getVerdict: () => new Promise(() => {}) };
    const check = createPdqKnownMaterialCheck(client, { ...options, timeoutMs: 10 });
    const verdict = await check.run({ buffer: Buffer.from('anything') });
    expect(verdict.classification).toBe('unavailable');
  });

  it('defaults the timeouts to positive numbers of milliseconds', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_HASH_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('bytes with no hash are never allowed on that basis', () => {
  const neverAsked = {
    asked: 0,
    async getVerdict() {
      this.asked += 1;
      return { classification: 'no-known-match', source: 'test' };
    },
  };

  it.each([
    ['no hash and a reason', async () => ({ hash: null, reason: 'not-an-image' }), 'not-an-image'],
    ['no result at all', async () => undefined, 'no-hash'],
    ['a hash that is not a string', async () => ({ hash: 42 }), 'no-hash'],
    [
      'a hasher that throws',
      async () => {
        throw new Error('decoder blew up');
      },
      'hash-failed',
    ],
  ])(
    'answers unavailable, without asking the verdict client, for %s',
    async (_name, hasher, reason) => {
      neverAsked.asked = 0;
      const check = createPdqKnownMaterialCheck(neverAsked, {
        computeDigest,
        computeVerdictKey: hasher,
      });
      const verdict = await check.run({ buffer: Buffer.from('xx') });
      expect(verdict).toMatchObject({
        classification: 'unavailable',
        source: NO_HASH_SOURCE,
        reason,
        evidence: computeDigest(Buffer.from('xx')),
      });
      expect(neverAsked.asked).toBe(0);
    }
  );

  it('answers unavailable when hashing outlasts its own budget', async () => {
    const check = createPdqKnownMaterialCheck(neverAsked, {
      computeDigest,
      computeVerdictKey: () => new Promise(() => {}),
      hashTimeoutMs: 10,
    });
    const verdict = await check.run({ buffer: Buffer.from('xx') });
    expect(verdict).toMatchObject({ classification: 'unavailable', reason: 'hash-timeout' });
  });
});
