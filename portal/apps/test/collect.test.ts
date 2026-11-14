import { describe, expect, it } from 'vitest';
import type { SupportAccessSink } from '../src/collector/collect.js';
import { ONE, TWO, at, collect, exporterText, fakeSink } from './collectorText.js';

describe('the collector writes what the host said, and only that', () => {
  it('records an open tenant with its deadline and a closed tenant as closed', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      [
        {
          tenant: 'placeholder-one',
          state: 'open',
          lane: 'incident',
          granted: at(-600),
          deadline: at(13800),
          observed: at(-5),
        },
        { tenant: 'placeholder-two', state: 'closed', observed: at(-5) },
      ],
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 2, leftOut: 0, failed: 0 });
    expect(writes).toEqual([
      {
        tenantId: ONE,
        reading: {
          state: 'open',
          lane: 'incident',
          grantedAt: new Date(at(-600) * 1000),
          deadline: new Date(at(13800) * 1000),
        },
        observedAt: new Date(at(-5) * 1000),
      },
      {
        tenantId: TWO,
        reading: { state: 'closed', lane: null, grantedAt: null, deadline: null },
        observedAt: new Date(at(-5) * 1000),
      },
    ]);
    expect(lines).toContain('support-access: placeholder-one: recorded state=open');
    expect(lines).toContain('support-access: placeholder-two: recorded state=closed');
  });

  it('writes nothing for a host that sent no text', async () => {
    const { sink, writes } = fakeSink();
    const { summary } = await collect('', sink);
    expect(summary).toEqual({ accepted: true, recorded: 0, leftOut: 0, failed: 0 });
    expect(writes).toEqual([]);
  });

  it('writes nothing for a tenant the host did not report, whatever the page last held for it', async () => {
    const { sink, writes } = fakeSink();
    await collect([{ tenant: 'placeholder-one', state: 'closed', observed: at(-5) }], sink);
    expect(writes.map((w) => w.tenantId)).toEqual([ONE]);
  });

  it('writes nothing for a tenant the register does not know', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      [{ tenant: 'placeholder-stranger', state: 'closed', observed: at(-5) }],
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 0, leftOut: 1, failed: 0 });
    expect(writes).toEqual([]);
    expect(lines).toContain('support-access: placeholder-stranger: left out: unknown-tenant');
  });

  it('writes nothing for a series the host stamped too long ago, and takes one just inside the limit', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      [
        { tenant: 'placeholder-one', state: 'closed', observed: at(-901) },
        { tenant: 'placeholder-two', state: 'closed', observed: at(-900) },
      ],
      sink
    );
    expect(summary.recorded).toBe(1);
    expect(writes.map((w) => w.tenantId)).toEqual([TWO]);
    expect(lines).toContain('support-access: placeholder-one: left out: old');
  });

  it('writes nothing for a series dated ahead of now, and takes one just inside the limit', async () => {
    const { sink, writes } = fakeSink();
    const { lines } = await collect(
      [
        { tenant: 'placeholder-one', state: 'closed', observed: at(901) },
        { tenant: 'placeholder-two', state: 'closed', observed: at(900) },
      ],
      sink
    );
    expect(writes.map((w) => w.tenantId)).toEqual([TWO]);
    expect(lines).toContain('support-access: placeholder-one: left out: future');
  });

  it('writes nothing at all when the text is not the contract', async () => {
    const { sink, writes } = fakeSink();
    const { summary, lines } = await collect(
      [
        'branchleft_support_access_state{state="closed",tenant="placeholder-one"} 1',
        'branchleft_support_access_deadline_timestamp_seconds garbled',
      ].join('\n'),
      sink
    );
    expect(summary).toEqual({ accepted: false, recorded: 0, leftOut: 0, failed: 0 });
    expect(writes).toEqual([]);
    expect(lines).toEqual([
      'support-access: the exporter text is not the contract; nothing written',
    ]);
  });

  it('counts a refused write, goes on to the next tenant, and does not say why', async () => {
    const { sink, writes } = fakeSink({ failFor: ONE });
    const { summary, lines } = await collect(
      [
        { tenant: 'placeholder-one', state: 'closed', observed: at(-5) },
        { tenant: 'placeholder-two', state: 'closed', observed: at(-5) },
      ],
      sink
    );
    expect(summary).toEqual({ accepted: true, recorded: 1, leftOut: 0, failed: 1 });
    expect(writes.map((w) => w.tenantId)).toEqual([TWO]);
    expect(lines.join('\n')).not.toContain('database said no');
    expect(lines).toContain('support-access: placeholder-one: write failed');
  });

  it('puts no clock, lane or id in the run log', async () => {
    const { sink } = fakeSink();
    const { lines } = await collect(
      [
        {
          tenant: 'placeholder-one',
          state: 'open',
          lane: 'incident',
          granted: at(-60),
          deadline: at(600),
          observed: at(-5),
        },
      ],
      sink
    );
    const log = lines.join('\n');
    expect(log).not.toContain('incident');
    expect(log).not.toContain(ONE);
    expect(log).not.toMatch(/\d{10}/);
  });

  it('leaves a tenant that broke the contract out of the count and still writes the rest', async () => {
    const { sink, writes } = fakeSink();
    const text = [
      exporterText([{ tenant: 'placeholder-two', state: 'closed', observed: at(-5) }]),
      'branchleft_support_access_state{tenant="placeholder-one",state="closed"} 1',
    ].join('\n');
    const { summary } = await collect(text, sink);
    expect(summary).toEqual({ accepted: true, recorded: 1, leftOut: 1, failed: 0 });
    expect(writes.map((w) => w.tenantId)).toEqual([TWO]);
  });

  it('fails the run when the register cannot be read, so nothing is guessed', async () => {
    const { sink } = fakeSink();
    const broken: SupportAccessSink = {
      ...sink,
      listTenantSlugs: () => Promise.reject(new Error('no register')),
    };
    await expect(
      collect([{ tenant: 'placeholder-one', state: 'closed', observed: at(-5) }], broken)
    ).rejects.toThrow('no register');
  });
});
