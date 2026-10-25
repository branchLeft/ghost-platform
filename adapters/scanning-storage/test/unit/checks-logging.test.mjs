import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');

const computeDigest = (buffer) => buffer.toString('hex');
const buffer = Buffer.from('anything');
const digest = computeDigest(buffer);

const throwingClient = (value) => ({
  async getVerdict() {
    throw value;
  },
});
const neverClient = { getVerdict: () => new Promise(() => {}) };

const unavailableFromError = {
  classification: 'unavailable',
  source: 'pdq-known-material-check',
  evidence: digest,
};
const unavailableFromTimeout = {
  classification: 'unavailable',
  source: 'timeout',
  evidence: digest,
};

describe('createPdqKnownMaterialCheck logging', () => {
  it('logs once, with the digest and the error, when the verdict client throws', async () => {
    const logger = { error: vi.fn() };
    const check = createPdqKnownMaterialCheck(throwingClient(new Error('channel unreachable')), {
      computeDigest,
      logger,
    });
    const verdict = await check.run({ buffer });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const text = logger.error.mock.calls[0][0];
    expect(text).toContain(digest);
    expect(text).toContain('channel unreachable');
    expect(verdict).toEqual(unavailableFromError);
  });

  it('logs once, with the digest and a timeout reason, when the verdict client is too slow', async () => {
    const logger = { error: vi.fn() };
    const check = createPdqKnownMaterialCheck(neverClient, {
      computeDigest,
      timeoutMs: 10,
      logger,
    });
    const verdict = await check.run({ buffer });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const text = logger.error.mock.calls[0][0];
    expect(text).toContain(digest);
    expect(text).toMatch(/timeout/);
    expect(verdict.source).toBe('timeout');
    expect(verdict.classification).toBe('unavailable');
    expect(verdict.evidence).toBe(digest);
  });

  it('control: logs nothing on a clean answer', async () => {
    const logger = { error: vi.fn() };
    const check = createPdqKnownMaterialCheck(new FakeVerdictClient(), { computeDigest, logger });
    const verdict = await check.run({ buffer });
    expect(logger.error).not.toHaveBeenCalled();
    expect(verdict.classification).toBe('no-known-match');
  });

  it("control: logs nothing on a client's own unavailable answer", async () => {
    const logger = { error: vi.fn() };
    const client = {
      async getVerdict() {
        return { classification: 'unavailable' };
      },
    };
    const check = createPdqKnownMaterialCheck(client, { computeDigest, logger });
    await check.run({ buffer });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a logger that throws changes nothing', async () => {
    const logger = {
      error: () => {
        throw new Error('logger down');
      },
    };
    const thrown = createPdqKnownMaterialCheck(throwingClient(new Error('channel unreachable')), {
      computeDigest,
      logger,
    });
    await expect(thrown.run({ buffer })).resolves.toEqual(unavailableFromError);
    const slow = createPdqKnownMaterialCheck(neverClient, {
      computeDigest,
      timeoutMs: 10,
      logger,
    });
    await expect(slow.run({ buffer })).resolves.toEqual(unavailableFromTimeout);
  });

  it.each([{}, null, 'text'])(
    'a logger without an error function is ignored (logger %j)',
    async (logger) => {
      const check = createPdqKnownMaterialCheck(throwingClient(new Error('channel unreachable')), {
        computeDigest,
        logger,
      });
      await expect(check.run({ buffer })).resolves.toEqual(unavailableFromError);
    }
  );

  it.each([
    null,
    'plain string failure',
    Object.assign(new Error('first line\n' + 'x'.repeat(5000))),
  ])(
    'a rejection that is not an Error is logged as one bounded line (value %#)',
    async (thrownValue) => {
      const logger = { error: vi.fn() };
      const check = createPdqKnownMaterialCheck(throwingClient(thrownValue), {
        computeDigest,
        logger,
      });
      await check.run({ buffer });
      expect(logger.error).toHaveBeenCalledTimes(1);
      const text = logger.error.mock.calls[0][0];
      expect(text).not.toMatch(/\n/);
      expect(text.length).toBeLessThan(600);
    }
  );

  it.each([
    Object.create(null),
    {
      toString() {
        throw new Error('no print');
      },
    },
    {
      get message() {
        throw new Error('no message');
      },
    },
  ])(
    'a rejection that cannot be printed is still logged once and never throws (value %#)',
    async (thrownValue) => {
      const logger = { error: vi.fn() };
      const check = createPdqKnownMaterialCheck(throwingClient(thrownValue), {
        computeDigest,
        logger,
      });
      await expect(check.run({ buffer })).resolves.toEqual(unavailableFromError);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const text = logger.error.mock.calls[0][0];
      expect(text).toContain(digest);
      expect(text).toContain('<unprintable>');
      expect(text).not.toMatch(/\n/);
      expect(text.length).toBeLessThan(600);
    }
  );
});
