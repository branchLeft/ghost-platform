import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { captureLogger, fakeTransport, NEVER } from '../helpers/fake-verdict-transport.mjs';

const require = createRequire(import.meta.url);
const { ProductionVerdictClient } = require('../../src/production-verdict-client.js');

const KEY_A = 'PDQ_KEY_A_PLACEHOLDER';
const KEY_B = 'PDQ_KEY_B_PLACEHOLDER';
const FAST = { connectTimeoutMs: 25, totalTimeoutMs: 60 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clientFor(transport, extra = {}) {
  return new ProductionVerdictClient({ transport, ...FAST, ...extra });
}

describe('ProductionVerdictClient: an answer must carry the key it answers', () => {
  it('a matching key is acted on, a match included', async () => {
    const { transport } = fakeTransport({
      echoKey: false,
      ask: (key) => ({ key, classification: 'csam', matchType: 'exact' }),
    });
    const verdict = await clientFor(transport).getVerdict(KEY_A);
    expect(verdict.classification).toBe('csam');
    expect(verdict.matchType).toBe('exact');
  });

  it('an answer with no key is held, never read as clean', async () => {
    const { transport } = fakeTransport({
      echoKey: false,
      ask: () => ({ classification: 'no-known-match' }),
    });
    const { logger, lines } = captureLogger();
    const verdict = await clientFor(transport, { logger }).getVerdict(KEY_A);
    expect(verdict.classification).toBe('unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reason=malformed-answer');
    expect(lines[0]).toContain('asked key');
  });

  it('an answer for another key is held, and logged as malformed', async () => {
    const { transport } = fakeTransport({
      echoKey: false,
      ask: () => ({ classification: 'no-known-match', key: 'OTHER' }),
    });
    const { logger, lines } = captureLogger();
    const verdict = await clientFor(transport, { logger }).getVerdict(KEY_A);
    expect(verdict.classification).toBe('unavailable');
    expect(lines[0]).toContain('reason=malformed-answer');
  });

  it.each([[null], [undefined], [''], [42], [['PDQ_KEY_A_PLACEHOLDER']], [{ key: KEY_A }]])(
    'a key of %j on the answer is not the asked key',
    async (key) => {
      const { transport } = fakeTransport({
        echoKey: false,
        ask: () => ({ classification: 'no-known-match', key }),
      });
      const verdict = await clientFor(transport).getVerdict(KEY_A);
      expect(verdict.classification).toBe('unavailable');
    }
  );

  // A transport that pools one channel and hands each reply to the oldest
  // ask still waiting. A timed-out ask is dropped from the line when it is
  // aborted, so the reply that was owed to it goes to the next ask. The
  // service's own reply carries the key it answers.
  function pooledTransport() {
    const waiting = [];
    const transport = {
      connect: async () => ({
        ask: (key, { signal }) =>
          new Promise((resolve) => {
            const entry = { key, resolve };
            waiting.push(entry);
            signal.addEventListener('abort', () => {
              const at = waiting.indexOf(entry);
              if (at >= 0) waiting.splice(at, 1);
            });
          }),
      }),
    };
    return {
      transport,
      deliver: (reply) => waiting.shift()?.resolve(reply),
      waitingCount: () => waiting.length,
    };
  }

  it('a late clean answer for an earlier key is never handed to the next key as clean', async () => {
    const { transport, deliver, waitingCount } = pooledTransport();
    const client = clientFor(transport);

    // A times out, and is held.
    const first = await client.getVerdict(KEY_A);
    expect(first.classification).toBe('unavailable');

    // B is asked; the supplier's answer for B is a match, but A's late clean
    // reply arrives first and the pool hands it to B.
    const second = client.getVerdict(KEY_B);
    await pause(5);
    expect(waitingCount()).toBe(1);
    deliver({ key: KEY_A, classification: 'no-known-match' });

    const verdict = await second;
    expect(verdict.classification).toBe('unavailable');
    expect(verdict.evidence).toBe(KEY_B);
  });

  it('control: the same pool, with the reply that belongs to B, gives B its own match', async () => {
    const { transport, deliver } = pooledTransport();
    const client = clientFor(transport);

    await client.getVerdict(KEY_A);
    const second = client.getVerdict(KEY_B);
    await pause(5);
    deliver({ key: KEY_B, classification: 'csam', matchType: 'exact' });

    await expect(second).resolves.toMatchObject({ classification: 'csam', evidence: KEY_B });
  });
});

describe('ProductionVerdictClient: whatever a transport throws is a hold, and the client never rejects', () => {
  const throwing = {
    toString() {
      throw new Error('toString threw');
    },
  };
  const throwingMessage = {
    get message() {
      throw new Error('message getter threw');
    },
  };
  const REASONS = [
    ['a string', 'peer refused'],
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['false', false],
    ['a symbol', Symbol('peer refused')],
    ['an object that looks like a clean answer', { classification: 'no-known-match', key: KEY_A }],
    ['an Error', new Error('peer refused')],
    ['a null-prototype object', Object.create(null)],
    ['an object whose toString throws', throwing],
    ['an object whose message getter throws', throwingMessage],
  ];

  function reject(reason, how) {
    if (how === 'throws') {
      return () => {
        throw reason;
      };
    }
    return () => Promise.reject(reason);
  }

  describe.each([['rejects'], ['throws']])('and it %s', (how) => {
    it.each(REASONS)('at connect: %s', async (_name, reason) => {
      const transport = { connect: reject(reason, how) };
      const { logger, lines } = captureLogger();
      const verdict = await clientFor(transport, { logger }).getVerdict(KEY_A);
      expect(verdict.classification).toBe('unavailable');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('reason=transport-error');
    });

    it.each(REASONS)('at ask: %s', async (_name, reason) => {
      const transport = { connect: async () => ({ ask: reject(reason, how) }) };
      const { logger, lines } = captureLogger();
      const verdict = await clientFor(transport, { logger }).getVerdict(KEY_A);
      expect(verdict.classification).toBe('unavailable');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('reason=transport-error');
    });
  });

  it('an unprintable key is held without throwing', async () => {
    const { transport, record } = fakeTransport();
    const { logger, lines } = captureLogger();
    const verdict = await clientFor(transport, { logger }).getVerdict(Object.create(null));
    expect(verdict.classification).toBe('unavailable');
    expect(record.connects).toBe(0);
    expect(lines).toHaveLength(1);
  });
});

describe('ProductionVerdictClient: its budget timers are always cleared', () => {
  // Tracks the timers the call under test creates through the global timer
  // functions, and returns how many are still live. A timeout is live until it
  // fires or is cleared. An interval is live until clearInterval: its callback
  // running does not end it. A timer another party owns is never in the set,
  // so its firing or clearing during the call changes nothing here. The
  // wrapper must see at least one timer, so a client that took its timers from
  // another source fails here rather than passing at zero.
  async function leavesNoTimers(transport) {
    const live = new Set();
    let created = 0;
    const real = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    globalThis.setTimeout = (fn, ...rest) => {
      if (typeof fn !== 'function') return real.setTimeout(fn, ...rest);
      const handle = real.setTimeout(
        (...args) => {
          live.delete(handle);
          return fn(...args);
        },
        ...rest
      );
      created += 1;
      live.add(handle);
      return handle;
    };
    globalThis.setInterval = (...args) => {
      const handle = real.setInterval(...args);
      created += 1;
      live.add(handle);
      return handle;
    };
    globalThis.clearTimeout = (handle) => {
      live.delete(handle);
      return real.clearTimeout(handle);
    };
    globalThis.clearInterval = (handle) => {
      live.delete(handle);
      return real.clearInterval(handle);
    };
    try {
      await clientFor(transport, { logger: { error: () => {} } }).getVerdict(KEY_A);
    } finally {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
    }
    expect(
      created,
      'the wrapper saw no timer from the call: its timers come from a source this check cannot see'
    ).toBeGreaterThan(0);
    return live.size;
  }

  it('after a clean answer', async () => {
    expect(await leavesNoTimers(fakeTransport().transport)).toBe(0);
  });

  it('after a match', async () => {
    const { transport } = fakeTransport({ ask: () => ({ classification: 'csam' }) });
    expect(await leavesNoTimers(transport)).toBe(0);
  });

  it('after a total timeout', async () => {
    expect(await leavesNoTimers(fakeTransport({ ask: NEVER }).transport)).toBe(0);
  });

  it('after a connect timeout', async () => {
    expect(await leavesNoTimers(fakeTransport({ connect: NEVER }).transport)).toBe(0);
  });

  it('after a transport error and after a malformed answer', async () => {
    const failing = fakeTransport({
      ask: () => {
        throw new Error('peer reset');
      },
    });
    expect(await leavesNoTimers(failing.transport)).toBe(0);
    const malformed = fakeTransport({ ask: () => ({ classification: 'looks-fine' }) });
    expect(await leavesNoTimers(malformed.transport)).toBe(0);
  });
});
