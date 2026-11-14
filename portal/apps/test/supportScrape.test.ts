import { describe, expect, it } from 'vitest';
import { parseSupportAccessScrape } from '../src/collector/supportScrape.js';
import { exporterText, type Sample } from './collectorText.js';

const read = (text: string) => {
  const outcome = parseSupportAccessScrape(text);
  if (outcome.kind !== 'read') throw new Error('the scrape was refused');
  return outcome;
};

describe("the exporter text, as node_exporter serves the host writer's file", () => {
  it('reads an open tenant with its lane, start, deadline and the host time', () => {
    const { readings, left } = read(
      exporterText([
        {
          tenant: 'placeholder-one',
          state: 'open',
          lane: 'consented',
          granted: 1.7e9,
          deadline: 1.7e9 + 14400,
          observed: 1.7e9 + 60,
        },
      ])
    );
    expect(left).toBe(0);
    expect(readings).toEqual([
      {
        slug: 'placeholder-one',
        reading: {
          state: 'open',
          lane: 'consented',
          grantedAt: new Date(1.7e9 * 1000),
          deadline: new Date((1.7e9 + 14400) * 1000),
        },
        observedAt: new Date((1.7e9 + 60) * 1000),
      },
    ]);
  });

  it('reads a closed tenant with no lane and no clock', () => {
    const { readings } = read(
      exporterText([{ tenant: 'placeholder-two', state: 'closed', observed: 1.7e9 }])
    );
    expect(readings).toEqual([
      {
        slug: 'placeholder-two',
        reading: { state: 'closed', lane: null, grantedAt: null, deadline: null },
        observedAt: new Date(1.7e9 * 1000),
      },
    ]);
  });

  it('reads an unknown tenant as unknown, and an open one with no lane', () => {
    const { readings } = read(
      exporterText([
        { tenant: 'placeholder-three', state: 'unknown', observed: 1.7e9 },
        { tenant: 'placeholder-four', state: 'open', observed: 1.7e9 },
      ])
    );
    expect(readings.map((r) => [r.slug, r.reading.state, r.reading.lane])).toEqual([
      ['placeholder-three', 'unknown', null],
      ['placeholder-four', 'open', null],
    ]);
  });

  it('reads the exponent form the exporter prints, and the plain form the writer prints', () => {
    const text = [
      'branchleft_support_access_state{state="closed",tenant="placeholder-one"} 1',
      'branchleft_support_access_observed_timestamp_seconds{tenant="placeholder-one"} 1.763117520123e+09',
      'branchleft_support_access_state{state="closed",tenant="placeholder-two"} 1',
      'branchleft_support_access_observed_timestamp_seconds{tenant="placeholder-two"} 1763117520.123',
    ].join('\n');
    const { readings } = read(text);
    expect(readings.map((r) => r.observedAt.getTime())).toEqual([1763117520123, 1763117520123]);
  });

  it('ignores every series that is not one of the five, with their help and type lines', () => {
    const text = [
      '# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.',
      '# TYPE node_cpu_seconds_total counter',
      'node_cpu_seconds_total{cpu="0",mode="idle"} 12345.6',
      'node_textfile_mtime_seconds{file="support_access.prom"} 1.7e+09',
      'branchleft_support_access_reason{tenant="placeholder-one"} 1',
      'go_goroutines 7',
      exporterText([{ tenant: 'placeholder-one', state: 'closed', observed: 1.7e9 }]),
    ].join('\n');
    expect(read(text).readings.map((r) => r.slug)).toEqual(['placeholder-one']);
  });

  it('ignores a series of ours that carries a label outside the list, and the tenant it names stays unread', () => {
    const text = [
      'branchleft_support_access_state{state="closed",tenant="placeholder-one",reason="x"} 1',
      'branchleft_support_access_observed_timestamp_seconds{tenant="placeholder-one"} 1.7e9',
    ].join('\n');
    const outcome = read(text);
    expect(outcome.readings).toEqual([]);
    expect(outcome.left).toBe(1);
  });

  it('says nothing for an empty text', () => {
    expect(read('')).toEqual({ kind: 'read', readings: [], left: 0 });
  });
});

describe('a tenant whose own series break the contract has no reading, and the others still do', () => {
  const good: Sample = { tenant: 'placeholder-good', state: 'closed', observed: 1.7e9 };
  const lines = (...extra: string[]): string => [exporterText([good]), ...extra].join('\n');
  const state = (tenant: string, value: string, label = 'closed'): string =>
    `branchleft_support_access_state{tenant="${tenant}",state="${label}"} ${value}`;
  const observed = (tenant: string, value: string): string =>
    `branchleft_support_access_observed_timestamp_seconds{tenant="${tenant}"} ${value}`;

  it.each([
    [
      'two state series',
      [state('bad-tenant', '1'), state('bad-tenant', '1', 'open'), observed('bad-tenant', '1.7e9')],
    ],
    [
      'a state with a value other than one',
      [state('bad-tenant', '0'), observed('bad-tenant', '1.7e9')],
    ],
    [
      'a state outside the closed list',
      [state('bad-tenant', '1', 'maybe'), observed('bad-tenant', '1.7e9')],
    ],
    ['no state', [observed('bad-tenant', '1.7e9')]],
    ['no host time', [state('bad-tenant', '1')]],
    [
      'two host times',
      [state('bad-tenant', '1'), observed('bad-tenant', '1.7e9'), observed('bad-tenant', '1.7e9')],
    ],
    [
      'a host time that is not a number',
      [state('bad-tenant', '1'), observed('bad-tenant', 'soon')],
    ],
    ['a negative host time', [state('bad-tenant', '1'), observed('bad-tenant', '-5')]],
    ['a host time of NaN', [state('bad-tenant', '1'), observed('bad-tenant', 'NaN')]],
    [
      'a lane on a closed account',
      [
        state('bad-tenant', '1'),
        'branchleft_support_access_lane{tenant="bad-tenant",lane="incident"} 1',
        observed('bad-tenant', '1.7e9'),
      ],
    ],
    [
      'a deadline on a closed account',
      [
        state('bad-tenant', '1'),
        'branchleft_support_access_deadline_timestamp_seconds{tenant="bad-tenant"} 1.7e9',
        observed('bad-tenant', '1.7e9'),
      ],
    ],
    [
      'a lane outside the closed list',
      [
        state('bad-tenant', '1', 'open'),
        'branchleft_support_access_lane{tenant="bad-tenant",lane="secret"} 1',
        observed('bad-tenant', '1.7e9'),
      ],
    ],
    [
      'a deadline that is not a number',
      [
        state('bad-tenant', '1', 'open'),
        'branchleft_support_access_deadline_timestamp_seconds{tenant="bad-tenant"} later',
        observed('bad-tenant', '1.7e9'),
      ],
    ],
    [
      'two deadlines',
      [
        state('bad-tenant', '1', 'open'),
        'branchleft_support_access_deadline_timestamp_seconds{tenant="bad-tenant"} 1.7e9',
        'branchleft_support_access_deadline_timestamp_seconds{tenant="bad-tenant"} 1.8e9',
        observed('bad-tenant', '1.7e9'),
      ],
    ],
    [
      'a lane given twice',
      [
        state('bad-tenant', '1', 'open'),
        'branchleft_support_access_lane{tenant="bad-tenant",lane="incident"} 1',
        'branchleft_support_access_lane{tenant="bad-tenant",lane="consented"} 1',
        observed('bad-tenant', '1.7e9'),
      ],
    ],
    [
      'a lane whose value is not one',
      [
        state('bad-tenant', '1', 'open'),
        'branchleft_support_access_lane{tenant="bad-tenant",lane="incident"} 0',
        observed('bad-tenant', '1.7e9'),
      ],
    ],
  ])('%s', (_name, extra) => {
    const outcome = read(lines(...extra));
    expect(outcome.readings.map((r) => r.slug)).toEqual(['placeholder-good']);
    expect(outcome.left).toBe(1);
  });

  it('ignores a series whose tenant label is not a slug', () => {
    const outcome = read(lines(state('Not A Slug', '1'), observed('Not A Slug', '1.7e9')));
    expect(outcome.readings.map((r) => r.slug)).toEqual(['placeholder-good']);
    expect(outcome.left).toBe(0);
  });
});

describe('a line that is ours and is not a sample refuses the whole text', () => {
  it.each([
    ['a name with no labels or value', 'branchleft_support_access_state'],
    ['a name with a value and no labels', 'branchleft_support_access_state 1'],
    [
      'a label that is not quoted',
      'branchleft_support_access_state{tenant=placeholder,state="closed"} 1',
    ],
    [
      'a label value with an escape',
      'branchleft_support_access_state{tenant="a\\"b",state="closed"} 1',
    ],
    [
      'a repeated label',
      'branchleft_support_access_state{tenant="placeholder-one",tenant="placeholder-one",state="closed"} 1',
    ],
    [
      'a sample with no value',
      'branchleft_support_access_state{tenant="placeholder-one",state="closed"}',
    ],
  ])('%s', (_name, line) => {
    expect(parseSupportAccessScrape(`${line}\n`)).toEqual({ kind: 'refused' });
  });

  it('but a line that is not ours and is malformed is only skipped', () => {
    expect(parseSupportAccessScrape('node_garbled{{\nnot a sample at all\n')).toEqual({
      kind: 'read',
      readings: [],
      left: 0,
    });
  });
});
