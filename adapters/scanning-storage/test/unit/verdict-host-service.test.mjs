import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { hashOf, startRig, verdictFor } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const { readConfig } = require('../../verdict-host/config.js');
const { HostMetrics } = require('../../verdict-host/metrics.js');

let rig;
let second;
afterEach(async () => {
  await second?.cleanup();
  await rig?.cleanup();
  rig = undefined;
  second = undefined;
});

const series = (text, name) => {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  return line === undefined ? undefined : Number(line.split(' ').pop());
};

describe('a restart of the host process', () => {
  it('keeps a hash that was waiting, and hands it to the service after the restart', async () => {
    rig = await startRig();
    rig.host.queue.ask(hashOf(1));
    rig.host.queue.ask(hashOf(2));
    const { batch } = await rig.poll();
    await rig.post(batch, [verdictFor(hashOf(2))]);
    const { directory } = rig;
    await rig.stop();

    second = await startRig({ directory });
    expect(second.host.queue.counts()).toMatchObject({ verdicts: 1 });
    const answer = await second.poll();
    expect(answer.hashes).toEqual([hashOf(1)]);
  });
});

describe('the age metric', () => {
  it('grows while nothing drains and returns to zero once draining resumes', async () => {
    rig = await startRig();
    const age = () =>
      series(rig.host.metrics.render(), 'verdict_host_oldest_unverdicted_age_seconds');
    expect(age()).toBe(0);
    rig.host.queue.ask(hashOf(1));
    rig.clock.advance(90_000);
    expect(age()).toBeGreaterThanOrEqual(90);
    rig.clock.advance(60_000);
    expect(age()).toBeGreaterThanOrEqual(150);

    // The service dials in and drains: the same series falls to zero.
    const { batch } = await rig.poll();
    await rig.post(batch, [verdictFor(hashOf(1))]);
    expect(age()).toBe(0);
  });

  it('is written to the textfile for the collector', async () => {
    rig = await startRig();
    rig.host.queue.ask(hashOf(1));
    await rig.stop();
    const text = fs.readFileSync(rig.config.metricsFile, 'utf8');
    expect(text).toContain('# TYPE verdict_host_oldest_unverdicted_age_seconds gauge');
    expect(text).toContain('verdict_host_egress_refused_total 0');
  });
});

describe('the other series', () => {
  it('count polls, posts, asks and refusals, and drop a label outside the set', async () => {
    rig = await startRig({ config: { holdMs: 60 } });
    await rig.poll();
    await rig.call('GET', '/safety/v1/pending', { headers: {} });
    rig.host.metrics.count('polls', 'made-up-by-a-request');
    rig.host.metrics.count('nothing', 'x');
    const text = rig.host.metrics.render();
    expect(series(text, 'verdict_host_polls_total{result="empty"}')).toBe(1);
    expect(series(text, 'verdict_host_refused_total{reason="timestamp"}')).toBe(1);
    expect(text).not.toContain('made-up-by-a-request');
    expect(series(text, 'verdict_host_last_poll_timestamp_seconds')).toBeGreaterThan(0);
  });

  it('read the guard count at render time', () => {
    const metrics = new HostMetrics({
      queue: { counts: () => ({ queued: 0, leased: 0 }), oldestAgeSeconds: () => 0 },
      egressRefused: () => 3,
    });
    expect(series(metrics.render(), 'verdict_host_egress_refused_total')).toBe(3);
  });
});

describe('configuration', () => {
  const base = {
    VERDICT_HOST_SOCKET: '/run/vh/v.sock',
    VERDICT_HOST_JOURNAL: '/var/lib/vh/queue.journal',
    VERDICT_HOST_VERIFY_KEY_FILE: '/etc/vh/channel-signing.pub',
    VERDICT_HOST_METRICS_FILE: '/var/lib/node_exporter/vh.prom',
    VERDICT_HOST_INBOUND_PORT: '8443',
  };

  it('reads a complete environment and applies the defaults', () => {
    expect(readConfig(base)).toMatchObject({
      socketMode: 0o600,
      inboundHost: '127.0.0.1',
      inboundPort: 8443,
      holdMs: 30_000,
      replayWindowSeconds: 60,
    });
  });

  it('reads the optional numbers and the socket mode', () => {
    const config = readConfig({
      ...base,
      VERDICT_HOST_SOCKET_MODE: '660',
      VERDICT_HOST_HOLD_MS: '5000',
      VERDICT_HOST_INBOUND_HOST: '::1',
    });
    expect(config).toMatchObject({ socketMode: 0o660, holdMs: 5000, inboundHost: '::1' });
  });

  it.each([
    ['a missing socket', { VERDICT_HOST_SOCKET: undefined }, 'VERDICT_HOST_SOCKET'],
    ['a relative journal', { VERDICT_HOST_JOURNAL: 'queue.journal' }, 'VERDICT_HOST_JOURNAL'],
    [
      'a missing key file',
      { VERDICT_HOST_VERIFY_KEY_FILE: undefined },
      'VERDICT_HOST_VERIFY_KEY_FILE',
    ],
    ['a metrics file not ending .prom', { VERDICT_HOST_METRICS_FILE: '/var/x.txt' }, '.prom'],
    ['no inbound port', { VERDICT_HOST_INBOUND_PORT: undefined }, 'INBOUND_PORT is required'],
    ['a port out of range', { VERDICT_HOST_INBOUND_PORT: '70000' }, 'between 1 and 65535'],
    ['a port that is not a number', { VERDICT_HOST_INBOUND_PORT: 'http' }, 'whole number'],
    [
      'an inbound address that is not loopback',
      { VERDICT_HOST_INBOUND_HOST: '10.0.0.5' },
      'loopback',
    ],
    ['a wildcard inbound address', { VERDICT_HOST_INBOUND_HOST: '0.0.0.0' }, 'loopback'],
    ['a socket mode that is not octal', { VERDICT_HOST_SOCKET_MODE: '9' }, 'octal'],
    ['a hold of zero', { VERDICT_HOST_HOLD_MS: '0' }, 'VERDICT_HOST_HOLD_MS'],
  ])('refuses %s', (_name, change, message) => {
    expect(() => readConfig({ ...base, ...change })).toThrow(message);
  });
});
