import { describe, expect, it } from 'vitest';
import {
  checkLogo,
  hashLogo,
  LogoRefusedError,
  writeWithLogoCheck,
  type LogoRefusalReason,
  type LogoVerdictSource,
} from '../src/frontdoor/logoCheck.js';
import { loadAdapter, LOGO, RowStore } from './logoCheckRig.js';

const adapter = await loadAdapter();
const LOGO_HASH = hashLogo(LOGO);

async function refusal(promise: Promise<unknown>): Promise<LogoRefusalReason | 'NOT_REFUSED'> {
  try {
    await promise;
    return 'NOT_REFUSED';
  } catch (error) {
    if (error instanceof LogoRefusedError) return error.reason;
    throw error;
  }
}

describe('hashLogo', () => {
  it('is SHA-256 in lower-case hexadecimal', () => {
    expect(hashLogo(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('a logo through the safety service client and a fake transport', () => {
  it('writes the record, with the hash that was asked about, when there is no known match', async () => {
    const { transport, record } = adapter.fakeTransport();
    const rows = new RowStore();
    await writeWithLogoCheck(LOGO, { verdicts: adapter.client(transport) }, rows.write);
    expect(record.asked).toEqual([LOGO_HASH]);
    expect(rows.rows).toEqual([{ logoHash: LOGO_HASH }]);
  });

  it('refuses a logo whose hash is on the test list and writes no row', async () => {
    const listed = adapter.fakeTransport({
      ask: (key) =>
        key === LOGO_HASH ? { classification: 'test' } : { classification: 'no-known-match' },
    });
    const rows = new RowStore();
    const options = { verdicts: adapter.client(listed.transport) };
    expect(await refusal(writeWithLogoCheck(LOGO, options, rows.write))).toBe('TEST_LISTED');
    expect(rows.rows).toEqual([]);
    expect(listed.record.asked).toEqual([LOGO_HASH]);
    // The list is by hash: other bytes are not caught by it.
    const other = new Uint8Array([9, 9, 9]);
    await writeWithLogoCheck(other, options, rows.write);
    expect(rows.rows).toEqual([{ logoHash: hashLogo(other) }]);
  });

  it.each(['csam', 'harmful-abusive-material'])(
    'refuses %s as blocked with no row',
    async (kind) => {
      const { transport } = adapter.fakeTransport({ ask: () => ({ classification: kind }) });
      const rows = new RowStore();
      const outcome = writeWithLogoCheck(LOGO, { verdicts: adapter.client(transport) }, rows.write);
      expect(await refusal(outcome)).toBe('BLOCKED');
      expect(rows.rows).toEqual([]);
    }
  );

  const unavailable: Array<[string, Parameters<typeof adapter.fakeTransport>[0]]> = [
    ['the connection is refused', { connect: () => Promise.reject(new Error('refused')) }],
    ['the connection never completes', { connect: adapter.NEVER }],
    ['no answer arrives', { ask: adapter.NEVER }],
    ['the ask rejects', { ask: () => Promise.reject(new Error('reset')) }],
    ['the channel says unavailable', { ask: () => ({ classification: 'unavailable' }) }],
    ['the classification is unknown', { ask: () => ({ classification: 'maybe' }) }],
    [
      'the classification is spelled in the wrong case',
      { ask: () => ({ classification: 'TEST' }) },
    ],
    ['the answer has no classification', { ask: () => ({}) }],
    ['the answer is not an object', { ask: () => 'no-known-match' }],
    [
      'the answer names another key',
      { ask: () => ({ key: 'x', classification: 'no-known-match' }), echoKey: false },
    ],
  ];

  it.each(unavailable)('refuses, writing no row, when %s', async (_name, options) => {
    const { transport } = adapter.fakeTransport(options);
    const rows = new RowStore();
    const outcome = writeWithLogoCheck(LOGO, { verdicts: adapter.client(transport) }, rows.write);
    expect(await refusal(outcome)).toBe('UNAVAILABLE');
    expect(rows.rows).toEqual([]);
  });
});

describe('a seam that misbehaves', () => {
  async function refusedWith(verdicts: LogoVerdictSource, timeoutMs?: number): Promise<string> {
    const rows = new RowStore();
    const outcome = writeWithLogoCheck(LOGO, { verdicts, timeoutMs }, rows.write);
    const reason = await refusal(outcome);
    expect(rows.rows).toEqual([]);
    return reason;
  }

  it('is refused when it throws before it returns a promise', async () => {
    const verdicts: LogoVerdictSource = {
      getVerdict: () => {
        throw new Error('boom');
      },
    };
    expect(await refusedWith(verdicts)).toBe('UNAVAILABLE');
  });

  it('is refused when it rejects with something that is not an error', async () => {
    const verdicts: LogoVerdictSource = { getVerdict: () => Promise.reject(null) };
    expect(await refusedWith(verdicts)).toBe('UNAVAILABLE');
  });

  it('is refused at the ceiling when it never answers, and a late failure is not unhandled', async () => {
    const unhandled: unknown[] = [];
    const watch = (reason: unknown): number => unhandled.push(reason);
    process.on('unhandledRejection', watch);
    try {
      const verdicts: LogoVerdictSource = {
        getVerdict: () =>
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 60)),
      };
      expect(await refusedWith(verdicts, 20)).toBe('UNAVAILABLE');
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off('unhandledRejection', watch);
    }
    expect(unhandled).toEqual([]);
  });

  it('is refused when a clean answer does not name the hash it answers', async () => {
    const verdicts: LogoVerdictSource = {
      getVerdict: () => Promise.resolve({ classification: 'no-known-match' }),
    };
    expect(await refusedWith(verdicts)).toBe('UNAVAILABLE');
    const other: LogoVerdictSource = {
      getVerdict: () =>
        Promise.resolve({ classification: 'no-known-match', evidence: 'f'.repeat(64) }),
    };
    expect(await refusedWith(other)).toBe('UNAVAILABLE');
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'does not read %s as a classification',
    async (name) => {
      const verdicts: LogoVerdictSource = {
        getVerdict: () => Promise.resolve({ classification: name }),
      };
      expect(await refusedWith(verdicts)).toBe('UNAVAILABLE');
    }
  );
});

describe('what is submitted', () => {
  const never: LogoVerdictSource = {
    getVerdict: () => Promise.reject(new Error('the service must not be asked')),
  };

  it('writes with no hash, and asks nothing, when there is no logo', async () => {
    const { transport, record } = adapter.fakeTransport();
    const rows = new RowStore();
    await writeWithLogoCheck(undefined, { verdicts: adapter.client(transport) }, rows.write);
    expect(rows.rows).toEqual([{ logoHash: undefined }]);
    expect(record.connects).toBe(0);
  });

  it.each<[string, unknown]>([
    ['an empty file', new Uint8Array(0)],
    ['text', 'not bytes'],
    ['null', null],
  ])('refuses %s as an invalid logo without asking the service', async (_name, bytes) => {
    const rows = new RowStore();
    const outcome = writeWithLogoCheck(bytes as Uint8Array, { verdicts: never }, rows.write);
    expect(await refusal(outcome)).toBe('INVALID_LOGO');
    expect(rows.rows).toEqual([]);
  });

  it('returns the hash from checkLogo on a clean answer', async () => {
    const { transport } = adapter.fakeTransport();
    expect(await checkLogo(LOGO, { verdicts: adapter.client(transport) })).toBe(LOGO_HASH);
  });
});
