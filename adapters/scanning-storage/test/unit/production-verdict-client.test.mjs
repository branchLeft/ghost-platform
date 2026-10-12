import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { captureLogger, fakeTransport, NEVER } from '../helpers/fake-verdict-transport.mjs';

const require = createRequire(import.meta.url);
const {
  ProductionVerdictClient,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
} = require('../../src/production-verdict-client.js');
const { VerdictClient } = require('../../src/verdict-client.js');
const { DEFAULT_TIMEOUT_MS } = require('../../src/checks.js');

const KEY = 'PDQ_KEY_PLACEHOLDER';
const FAST = { connectTimeoutMs: 25, totalTimeoutMs: 60 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clientFor(transport, extra = {}) {
  return new ProductionVerdictClient({ transport, ...FAST, ...extra });
}

describe('ProductionVerdictClient: an answer inside the budget is acted on', () => {
  it('is a VerdictClient, so the existing seam takes it unchanged', () => {
    const { transport } = fakeTransport();
    expect(clientFor(transport)).toBeInstanceOf(VerdictClient);
  });

  it('allow: a clean answer is no-known-match, naming the key it was asked about', async () => {
    const { transport, record } = fakeTransport({
      ask: () => ({ classification: 'no-known-match' }),
    });
    const verdict = await clientFor(transport).getVerdict(KEY);
    expect(verdict).toEqual({
      classification: 'no-known-match',
      source: 'production-verdict-client',
      evidence: KEY,
    });
    expect(record.asked).toEqual([KEY]);
  });

  it.each([
    ['csam', 'exact'],
    ['harmful-abusive-material', 'near'],
    ['test', undefined],
  ])(
    'refuse: a known match (%s) is passed on as the match it is',
    async (classification, matchType) => {
      const { transport } = fakeTransport({ ask: () => ({ classification, matchType }) });
      const verdict = await clientFor(transport).getVerdict(KEY);
      expect(verdict.classification).toBe(classification);
      expect(verdict.evidence).toBe(KEY);
      if (matchType === undefined) {
        expect(verdict).not.toHaveProperty('matchType');
      } else {
        expect(verdict.matchType).toBe(matchType);
      }
    }
  );

  it('closes the connection it opened, and does not abort an answered request', async () => {
    const { transport, record } = fakeTransport();
    await clientFor(transport).getVerdict(KEY);
    expect(record.closed).toBe(1);
    expect(record.askSignals[0].aborted).toBe(false);
  });

  it('a connection with no close() is fine', async () => {
    const transport = {
      connect: async () => ({ ask: async () => ({ classification: 'no-known-match' }) }),
    };
    await expect(clientFor(transport).getVerdict(KEY)).resolves.toMatchObject({
      classification: 'no-known-match',
    });
  });
});

describe('ProductionVerdictClient: anything but an answer inside the budget is a hold', () => {
  it('total timeout: a channel that never answers is unavailable, and the request is told to stop', async () => {
    const { transport, record } = fakeTransport({ ask: NEVER });
    const { logger, lines } = captureLogger();
    const started = Date.now();

    const verdict = await clientFor(transport, { logger }).getVerdict(KEY);

    expect(verdict.classification).toBe('unavailable');
    expect(verdict.evidence).toBe(KEY);
    expect(Date.now() - started).toBeLessThan(FAST.totalTimeoutMs * 5);
    expect(record.askSignals[0].aborted).toBe(true);
    expect(record.closed).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('VERDICT_UNAVAILABLE');
    expect(lines[0]).toContain('reason=total-timeout');
    expect(lines[0]).toContain(KEY);
  });

  it('a clean answer that arrives after the budget is not an allow', async () => {
    const { transport } = fakeTransport({
      ask: async () => {
        await pause(FAST.totalTimeoutMs * 3);
        return { classification: 'no-known-match' };
      },
    });
    const verdict = await clientFor(transport).getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
    // Give the late answer time to land: it must change nothing already returned.
    await pause(FAST.totalTimeoutMs * 4);
    expect(verdict.classification).toBe('unavailable');
  });

  it('connect timeout: a channel that never connects is unavailable, and nothing is asked', async () => {
    const { transport, record } = fakeTransport({ connect: NEVER });
    const { logger, lines } = captureLogger();

    const verdict = await clientFor(transport, { logger }).getVerdict(KEY);

    expect(verdict.classification).toBe('unavailable');
    expect(record.asked).toEqual([]);
    expect(record.connectSignals[0].aborted).toBe(true);
    expect(lines[0]).toContain('reason=connect-timeout');
  });

  it('connect timeout is shorter than the total, so a slow connect does not spend the whole budget', async () => {
    const { transport } = fakeTransport({ connect: NEVER });
    const started = Date.now();
    await clientFor(transport, { connectTimeoutMs: 20, totalTimeoutMs: 2000 }).getVerdict(KEY);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a connection that arrives after its budget is closed, never used', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { transport, record, connection } = fakeTransport({
      connect: async () => {
        await gate;
        return connection;
      },
    });
    const verdict = await clientFor(transport).getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
    release();
    await pause(20);
    expect(record.closed).toBe(1);
    expect(record.asked).toEqual([]);
  });

  it('the total budget covers connect plus answer together', async () => {
    const { transport } = fakeTransport({
      connect: async ({ connection }) => {
        await pause(35);
        return connection;
      },
      ask: async () => {
        await pause(35);
        return { classification: 'no-known-match' };
      },
    });
    // Each step is inside its own limit; together they pass the total.
    const verdict = await clientFor(transport, {
      connectTimeoutMs: 50,
      totalTimeoutMs: 55,
    }).getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
  });

  it.each([
    [
      'connect rejects',
      () =>
        fakeTransport({
          connect: async () => {
            throw new Error('refused by peer');
          },
        }),
    ],
    [
      'connect throws before returning a promise',
      () => ({
        transport: {
          connect: () => {
            throw new Error('refused by peer');
          },
        },
      }),
    ],
    [
      'ask rejects',
      () =>
        fakeTransport({
          ask: async () => {
            throw new Error('peer reset');
          },
        }),
    ],
    [
      'ask throws before returning a promise',
      () => ({
        transport: {
          connect: async () => ({
            ask: () => {
              throw new Error('peer reset');
            },
          }),
        },
      }),
    ],
  ])('transport error: %s', async (_name, build) => {
    const { transport } = build();
    const { logger, lines } = captureLogger();
    const verdict = await clientFor(transport, { logger }).getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reason=transport-error');
    expect(lines[0]).toContain(KEY);
    expect(lines[0]).toMatch(/error=(refused by peer|peer reset)/);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'no-known-match'],
    ['an array', ['no-known-match']],
    ['an empty object', {}],
    ['a numeric classification', { classification: 0 }],
    ['an unknown classification', { classification: 'allow' }],
    ['a wrong-case classification', { classification: 'NO-KNOWN-MATCH' }],
    ['a padded classification', { classification: 'no-known-match ' }],
    ['a nested classification', { verdict: { classification: 'no-known-match' } }],
  ])('malformed answer: %s is unavailable, never clean', async (_name, answer) => {
    const { transport } = fakeTransport({ ask: () => answer });
    const { logger, lines } = captureLogger();
    const verdict = await clientFor(transport, { logger }).getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
    expect(lines[0]).toContain('reason=malformed-answer');
  });

  it('malformed answer: a transport that returns no usable connection is unavailable', async () => {
    const transport = { connect: async () => ({}) };
    const verdict = await clientFor(transport).getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
  });

  it('a channel that itself says unavailable is passed on as unavailable', async () => {
    const { transport } = fakeTransport({ ask: () => ({ classification: 'unavailable' }) });
    const { logger, lines } = captureLogger();
    const verdict = await clientFor(transport, { logger }).getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
    expect(lines[0]).toContain('reason=channel-unavailable');
  });

  it.each([
    ['an empty key', ''],
    ['no key', undefined],
    ['a number', 42],
    ['an object', {}],
  ])('invalid key: %s is held without dialling the channel', async (_name, key) => {
    const { transport, record } = fakeTransport();
    const verdict = await clientFor(transport).getVerdict(key);
    expect(verdict.classification).toBe('unavailable');
    expect(record.connects).toBe(0);
  });

  it('never rejects, even when the logger and close() both throw', async () => {
    const transport = {
      connect: async () => ({
        ask: async () => {
          throw new Error('peer reset');
        },
        close: () => {
          throw new Error('close failed');
        },
      }),
    };
    const logger = {
      error: () => {
        throw new Error('log failed');
      },
    };
    await expect(clientFor(transport, { logger }).getVerdict(KEY)).resolves.toMatchObject({
      classification: 'unavailable',
    });
  });

  it('logs one line per hold, with the error on one line and bounded', async () => {
    const { transport } = fakeTransport({
      ask: async () => {
        throw new Error(`first line\nsecond line ${'x'.repeat(1000)}`);
      },
    });
    const { logger, lines } = captureLogger();
    await clientFor(transport, { logger }).getVerdict(KEY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0].length).toBeLessThan(600);
  });
});

describe('ProductionVerdictClient construction', () => {
  it('requires a transport with connect()', () => {
    expect(() => new ProductionVerdictClient()).toThrow(/transport/);
    expect(() => new ProductionVerdictClient({ transport: {} })).toThrow(/transport/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '25', null, true])(
    'refuses a timeout of %j rather than running without one',
    (value) => {
      const { transport } = fakeTransport();
      expect(() => new ProductionVerdictClient({ transport, connectTimeoutMs: value })).toThrow(
        /connectTimeoutMs/
      );
      expect(() => new ProductionVerdictClient({ transport, totalTimeoutMs: value })).toThrow(
        /totalTimeoutMs/
      );
    }
  );

  it('defaults both budgets below the check budget, so this client decides first', () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(DEFAULT_TOTAL_TIMEOUT_MS);
    expect(DEFAULT_TOTAL_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS);
  });
});
