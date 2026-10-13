import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { captureLogger, fakeTransport } from '../helpers/fake-verdict-transport.mjs';

const require = createRequire(import.meta.url);
const {
  IN_PROCESS_FAKE,
  PRODUCTION,
  SCANNER_UNCONFIGURED,
  resolveVerdictSource,
} = require('../../src/verdict-source.js');
const { ProductionVerdictClient } = require('../../src/production-verdict-client.js');
const { FakeVerdictClient, UnconfiguredVerdictClient } = require('../../src/verdict-client.js');

const KEY = 'PDQ_KEY_PLACEHOLDER';

describe('resolveVerdictSource: the production value', () => {
  it('names the value exactly', () => {
    expect(PRODUCTION).toBe('production');
  });

  it('selects the production client over the injected transport, and refuses nothing at the door', async () => {
    const { transport, record } = fakeTransport({
      ask: () => ({ classification: 'csam', matchType: 'exact' }),
    });
    const source = resolveVerdictSource({ verdictSource: PRODUCTION }, { transport });
    expect(source.kind).toBe('production');
    expect(source.verdictClient).toBeInstanceOf(ProductionVerdictClient);
    expect(source.refuseUploadsReason).toBeNull();
    await expect(source.verdictClient.getVerdict(KEY)).resolves.toMatchObject({
      classification: 'csam',
    });
    expect(record.asked).toEqual([KEY]);
  });

  it('control: with no transport the value is no source at all, and says why', () => {
    const source = resolveVerdictSource({ verdictSource: PRODUCTION });
    expect(source.kind).toBe('unconfigured');
    expect(source.refuseUploadsReason).toBe(SCANNER_UNCONFIGURED);
    expect(source.verdictClient).toBeInstanceOf(UnconfiguredVerdictClient);
    expect(source.configError).toMatch(/transport/);
  });

  it.each([null, {}, { connect: 'dial' }])(
    'control: an unusable transport (%j) is no source',
    (transport) => {
      const source = resolveVerdictSource({ verdictSource: PRODUCTION }, { transport });
      expect(source.refuseUploadsReason).toBe(SCANNER_UNCONFIGURED);
    }
  );

  it.each([
    'PRODUCTION',
    ' production',
    'production ',
    'prod',
    'live',
    'true',
    true,
    1,
    '',
    null,
    undefined,
  ])(
    'control: the value %j does not select it, so a typo cannot open the gate',
    (verdictSource) => {
      const { transport } = fakeTransport();
      const source = resolveVerdictSource({ verdictSource }, { transport });
      expect(source.kind).toBe('unconfigured');
      expect(source.refuseUploadsReason).toBe(SCANNER_UNCONFIGURED);
    }
  );

  it('control: the seed keys of the fake never reach the production client', () => {
    const { transport } = fakeTransport();
    const source = resolveVerdictSource(
      {
        verdictSource: PRODUCTION,
        refuse: { d: { classification: 'csam' } },
        unavailable: ['x'],
        resolvePath: '/tmp/x',
      },
      { transport }
    );
    expect(source.verdictClient).not.toBeInstanceOf(FakeVerdictClient);
  });

  it('control: the fake is still selected by its own value, and only by it', () => {
    const { transport } = fakeTransport();
    const source = resolveVerdictSource({ verdictSource: IN_PROCESS_FAKE }, { transport });
    expect(source.kind).toBe(IN_PROCESS_FAKE);
    expect(source.verdictClient).toBeInstanceOf(FakeVerdictClient);
  });

  it('reads both budgets from config (strings, as env config gives them)', async () => {
    const { transport } = fakeTransport({ ask: () => new Promise(() => {}) });
    const source = resolveVerdictSource(
      { verdictSource: PRODUCTION, verdictConnectTimeoutMs: '10', verdictTotalTimeoutMs: '30' },
      { transport, logger: { error: () => {} } }
    );
    const started = Date.now();
    const verdict = await source.verdictClient.getVerdict(KEY);
    expect(verdict.classification).toBe('unavailable');
    // The default total budget is far longer than this, so finishing here
    // shows the configured one was used.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it.each([
    ['connect', { verdictConnectTimeoutMs: '0' }],
    ['connect', { verdictConnectTimeoutMs: 'soon' }],
    ['connect', { verdictConnectTimeoutMs: -5 }],
    ['connect', { verdictConnectTimeoutMs: true }],
    ['total', { verdictTotalTimeoutMs: '0' }],
    ['total', { verdictTotalTimeoutMs: 'never' }],
    ['total', { verdictTotalTimeoutMs: 'Infinity' }],
  ])(
    'control: a bad %s budget is no source rather than an unbounded wait (%j)',
    (_which, extra) => {
      const { transport } = fakeTransport();
      const source = resolveVerdictSource({ verdictSource: PRODUCTION, ...extra }, { transport });
      expect(source.kind).toBe('unconfigured');
      expect(source.refuseUploadsReason).toBe(SCANNER_UNCONFIGURED);
      expect(source.configError).toMatch(/TimeoutMs/);
    }
  );

  it('logs a hold to the injected logger, falling back to the config logger', async () => {
    const injected = captureLogger();
    const fromConfig = captureLogger();
    const failing = fakeTransport({
      ask: async () => {
        throw new Error('peer reset');
      },
    });

    await resolveVerdictSource(
      { verdictSource: PRODUCTION, holdLogger: fromConfig.logger },
      { transport: failing.transport, logger: injected.logger }
    ).verdictClient.getVerdict(KEY);
    await resolveVerdictSource(
      { verdictSource: PRODUCTION, holdLogger: fromConfig.logger },
      { transport: failing.transport }
    ).verdictClient.getVerdict(KEY);

    expect(injected.lines).toHaveLength(1);
    expect(fromConfig.lines).toHaveLength(1);
  });
});
