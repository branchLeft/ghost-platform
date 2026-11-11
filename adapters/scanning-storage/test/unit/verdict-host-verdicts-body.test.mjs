import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { hashOf, verdictFor } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const { parseVerdictsBody, definitiveAnswers } = require('../../verdict-host/verdicts-body.js');

const BATCH = 'batch-name-0123456789';
const body = (verdicts, extra = {}) => JSON.stringify({ v: 1, batch: BATCH, verdicts, ...extra });

describe('parseVerdictsBody', () => {
  it('reads a body in the contract shape', () => {
    const read = parseVerdictsBody(
      body([
        verdictFor(hashOf(1)),
        verdictFor(hashOf(2), {
          classification: 'csam',
          matchType: 'near',
          decision: {
            action: 'refuse',
            tier: 'one',
            irreversible: true,
            control: false,
            steps: ['withhold', 'seal'],
          },
        }),
        verdictFor(hashOf(3), {
          classification: 'unavailable',
          decision: { action: 'hold', reason: 'unavailable' },
        }),
      ])
    );
    expect(read.batch).toBe(BATCH);
    expect(read.entries.map((e) => e.classification)).toEqual([
      'no-known-match',
      'csam',
      'unavailable',
    ]);
    expect(read.entries[1].matchType).toBe('near');
  });

  it.each([
    ['text that is not JSON', 'nope'],
    ['an array', '[]'],
    ['a wrong version', body([], { v: 2 })],
    ['an extra top-level field', body([], { extra: 1 })],
    ['a batch name that is too short', body([], { batch: 'short' })],
    ['verdicts that are not a list', body('x')],
    ['an entry that is not an object', body([1])],
    [
      'an entry with a field the version does not name',
      body([verdictFor(hashOf(1), { extra: true })]),
    ],
    ['a hash that is not a PDQ hash', body([verdictFor('not-a-hash')])],
    ['an unknown classification', body([verdictFor(hashOf(1), { classification: 'clean' })])],
    ['an unknown match type', body([verdictFor(hashOf(1), { matchType: 'fuzzy' })])],
    ['an empty source', body([verdictFor(hashOf(1), { source: '' })])],
    ['audited that is not a boolean', body([verdictFor(hashOf(1), { audited: 'yes' })])],
    ['an unknown action', body([verdictFor(hashOf(1), { decision: { action: 'maybe' } })])],
    [
      'an allow with extra fields',
      body([verdictFor(hashOf(1), { decision: { action: 'allow', x: 1 } })]),
    ],
    [
      'a hold with an unknown reason',
      body([verdictFor(hashOf(1), { decision: { action: 'hold', reason: 'tired' } })]),
    ],
    [
      'a refuse with an unknown tier',
      body([
        verdictFor(hashOf(1), {
          decision: {
            action: 'refuse',
            tier: 'three',
            irreversible: true,
            control: true,
            steps: [],
          },
        }),
      ]),
    ],
    [
      'a refuse with an unknown step',
      body([
        verdictFor(hashOf(1), {
          decision: {
            action: 'refuse',
            tier: 'one',
            irreversible: true,
            control: true,
            steps: ['dance'],
          },
        }),
      ]),
    ],
    [
      'a refuse with a non-boolean flag',
      body([
        verdictFor(hashOf(1), {
          decision: { action: 'refuse', tier: 'one', irreversible: 1, control: true, steps: [] },
        }),
      ]),
    ],
    [
      'a refuse with steps that are not a list',
      body([
        verdictFor(hashOf(1), {
          decision: {
            action: 'refuse',
            tier: 'one',
            irreversible: true,
            control: true,
            steps: 'seal',
          },
        }),
      ]),
    ],
    ['a decision that is not an object', body([verdictFor(hashOf(1), { decision: 'allow' })])],
  ])('refuses the whole body for %s', (_name, text) => {
    expect(parseVerdictsBody(text)).toBeNull();
  });

  it('refuses the whole body when one entry in many is bad', () => {
    expect(parseVerdictsBody(body([verdictFor(hashOf(1)), verdictFor('bad')]))).toBeNull();
  });
});

describe('definitiveAnswers', () => {
  const read = (verdicts) => parseVerdictsBody(body(verdicts));
  const refuse = {
    action: 'refuse',
    tier: 'one',
    irreversible: true,
    control: false,
    steps: ['withhold'],
  };

  it('settles a clean answer only when the service also allowed it', () => {
    const answers = definitiveAnswers(
      read([
        verdictFor(hashOf(1)),
        verdictFor(hashOf(2), { decision: { action: 'hold', reason: 'audit-unavailable' } }),
        verdictFor(hashOf(3), { decision: refuse }),
      ]),
      [hashOf(1), hashOf(2), hashOf(3)]
    );
    expect([...answers.keys()]).toEqual([hashOf(1)]);
  });

  it('settles a matched classification whatever the decision says', () => {
    const answers = definitiveAnswers(
      read([
        verdictFor(hashOf(1), { classification: 'csam', matchType: 'exact', decision: refuse }),
        verdictFor(hashOf(2), {
          classification: 'harmful-abusive-material',
          decision: { action: 'allow' },
        }),
        verdictFor(hashOf(3), {
          classification: 'test',
          decision: { action: 'hold', reason: 'unavailable' },
        }),
      ]),
      [hashOf(1), hashOf(2), hashOf(3)]
    );
    expect(answers.get(hashOf(1))).toEqual({ classification: 'csam', matchType: 'exact' });
    expect(answers.get(hashOf(2))).toEqual({ classification: 'harmful-abusive-material' });
    expect(answers.get(hashOf(3))).toEqual({ classification: 'test' });
  });

  it('never settles an unavailable answer', () => {
    const answers = definitiveAnswers(
      read([
        verdictFor(hashOf(1), {
          classification: 'unavailable',
          decision: { action: 'hold', reason: 'unavailable' },
        }),
      ]),
      [hashOf(1)]
    );
    expect(answers.size).toBe(0);
  });

  it('ignores a hash that was not offered and drops one answered twice', () => {
    const answers = definitiveAnswers(
      read([
        verdictFor(hashOf(9)),
        verdictFor(hashOf(1)),
        verdictFor(hashOf(1), { classification: 'csam' }),
        verdictFor(hashOf(1)),
        verdictFor(hashOf(2)),
      ]),
      [hashOf(1), hashOf(2)]
    );
    expect([...answers.keys()]).toEqual([hashOf(2)]);
  });
});
