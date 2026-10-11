'use strict';

const { FakeVerdictClient, UnconfiguredVerdictClient } = require('./verdict-client');

// The only value of `verdictSource` that selects the in-process fake. Any
// other value, including unset, empty, a different case, a stray space or a
// boolean, is "no verdict source", so a typo can only ever fail closed.
const IN_PROCESS_FAKE = 'in-process-fake';

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

// Decides what answers verdict questions for one decorator instance. The
// real channel is a separate story and does not exist yet, so there are two
// outcomes today, and the default is the safe one.
//
//   verdictSource === 'in-process-fake'  the fake, seeded from this config.
//                                        For demo, dev and test paths only.
//   anything else                        no source: the decorator refuses
//                                        new uploads and keeps old holds held.
function resolveVerdictSource(config = {}) {
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
  return {
    kind: 'unconfigured',
    verdictClient: new UnconfiguredVerdictClient(),
    refuseUploadsReason: SCANNER_UNCONFIGURED,
  };
}

module.exports = {
  IN_PROCESS_FAKE,
  SCANNER_UNCONFIGURED,
  parseJsonConfig,
  resolveVerdictSource,
};
