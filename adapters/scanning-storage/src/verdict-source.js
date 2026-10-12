'use strict';

const { FakeVerdictClient, UnconfiguredVerdictClient } = require('./verdict-client');
const { ProductionVerdictClient } = require('./production-verdict-client');

// The only value of `verdictSource` that selects the in-process fake. Any
// other value, including unset, empty, a different case, a stray space or a
// boolean, is "no verdict source", so a typo can only ever fail closed.
const IN_PROCESS_FAKE = 'in-process-fake';

// The only value that selects the production client, matched as exactly as
// the fake's value and for the same reason.
const PRODUCTION = 'production';

// Stable, greppable token: the boot line and every refused upload carry it,
// and an alert rule matches on it. See verdict-source.md#alerting.
const SCANNER_UNCONFIGURED = 'SCANNER_UNCONFIGURED';

// `refuse` and `unavailable` are, respectively, a plain object of digest ->
// {classification, matchType} and a plain array of digests. Ghost's env-var
// config loader parses a JSON-shaped top-level value automatically, but a
// value nested under a feature key (storage__images__...) is not guaranteed
// to be, so a JSON string is accepted too rather than trusting that either
// way.
function parseJsonConfig(value, fallback) {
  if (typeof value !== 'string') {
    return value ?? fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// No source: every new upload is refused and an old hold stays held.
// `configError`, when present, says why a named source could not be built.
function unconfigured(configError) {
  return {
    kind: 'unconfigured',
    verdictClient: new UnconfiguredVerdictClient(),
    refuseUploadsReason: SCANNER_UNCONFIGURED,
    ...(configError === undefined ? {} : { configError }),
  };
}

// Timeouts arrive as strings from Ghost's env config. Unset is the client's
// default; anything set that is not a positive number reaches the client as
// NaN, which its constructor refuses, so a typo cannot lengthen a budget.
function parseTimeoutMs(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return Number.NaN;
  }
  return Number(value);
}

// A production source needs a transport, which only code can supply: the
// entry file does not pass one yet, so a deployment that names `production`
// today has no source and refuses, exactly as if nothing were configured.
// Any construction failure is the same outcome, with the cause kept.
function buildProductionSource(config, transport, logger) {
  try {
    const verdictClient = new ProductionVerdictClient({
      transport,
      connectTimeoutMs: parseTimeoutMs(config.verdictConnectTimeoutMs),
      totalTimeoutMs: parseTimeoutMs(config.verdictTotalTimeoutMs),
      logger,
    });
    return { kind: PRODUCTION, verdictClient, refuseUploadsReason: null };
  } catch (err) {
    return unconfigured(err.message);
  }
}

// Decides what answers verdict questions for one decorator instance. The
// default is the safe one.
//
//   verdictSource === 'in-process-fake'  the fake, seeded from this config.
//                                        For demo, dev and test paths only.
//   verdictSource === 'production'       the production client over the
//                                        injected `transport`; with none, or
//                                        with a bad budget, no source.
//   anything else                        no source: the decorator refuses
//                                        new uploads and keeps old holds held.
function resolveVerdictSource(config = {}, deps = {}) {
  if (config.verdictSource === PRODUCTION) {
    const { transport, logger } = deps ?? {};
    return buildProductionSource(config, transport, logger ?? config.holdLogger ?? console);
  }
  if (config.verdictSource === IN_PROCESS_FAKE) {
    return {
      kind: IN_PROCESS_FAKE,
      verdictClient: new FakeVerdictClient({
        refuse: parseJsonConfig(config.refuse, {}),
        unavailable: parseJsonConfig(config.unavailable, []),
        resolvePath: typeof config.resolvePath === 'string' ? config.resolvePath : undefined,
      }),
      refuseUploadsReason: null,
    };
  }
  return unconfigured();
}

module.exports = {
  IN_PROCESS_FAKE,
  PRODUCTION,
  SCANNER_UNCONFIGURED,
  parseJsonConfig,
  resolveVerdictSource,
};
