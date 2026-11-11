'use strict';

// The host end's metrics, written to a textfile for the host's collector
// (the same route as the decorator's, ../src/metrics.js). The names are a
// contract an alert rule is written against; verdict-host.md is the reference.
// The one that matters most is the producer-side age of the oldest unverdicted
// hash: a channel that looks alive while it has stopped answering shows up as
// that number growing, which no consumer-side liveness bit can show.

const PREFIX = 'verdict_host_';

const POLL_RESULTS = Object.freeze(['batch', 'empty', 'busy']);
const POST_RESULTS = Object.freeze(['accepted', 'gone', 'unreadable']);
const ASK_RESULTS = Object.freeze(['verdict', 'queued', 'full', 'error', 'bad']);
const REFUSAL_REASONS = Object.freeze([
  'timestamp',
  'nonce',
  'signature-missing',
  'window',
  'before-start',
  'signature',
  'replay',
]);

const LABELLED = Object.freeze({
  polls: ['result', POLL_RESULTS, 'Polls from the safety service, by outcome.'],
  posts: ['result', POST_RESULTS, 'Verdict posts from the safety service, by outcome.'],
  asks: ['result', ASK_RESULTS, 'Asks on the local socket, by outcome.'],
  refused: ['reason', REFUSAL_REASONS, 'Inbound requests refused as not from the safety service.'],
});

class HostMetrics {
  #queue;
  #now;
  #egressRefused;
  #counts = new Map();
  #lastPollSeconds = 0;

  constructor({ queue, now = Date.now, egressRefused = () => 0 }) {
    this.#queue = queue;
    this.#now = now;
    this.#egressRefused = egressRefused;
    for (const [family, [, values]] of Object.entries(LABELLED)) {
      for (const value of values) this.#counts.set(`${family}:${value}`, 0);
    }
  }

  // Counts one event. A label outside the family's set is dropped: a request
  // must not be able to grow the series.
  count(family, value) {
    const key = `${family}:${value}`;
    if (!this.#counts.has(key)) return;
    this.#counts.set(key, this.#counts.get(key) + 1);
    if (family === 'polls') this.#lastPollSeconds = Math.floor(this.#now() / 1000);
  }

  render() {
    const queueCounts = this.#queue.counts();
    const lines = [];
    const family = (name, type, help) => {
      lines.push(`# HELP ${PREFIX}${name} ${help}`, `# TYPE ${PREFIX}${name} ${type}`);
    };
    family(
      'oldest_unverdicted_age_seconds',
      'gauge',
      'Seconds the oldest hash without a verdict has waited; 0 when none.'
    );
    lines.push(`${PREFIX}oldest_unverdicted_age_seconds ${this.#queue.oldestAgeSeconds()}`);
    family('queued_hashes', 'gauge', 'Hashes waiting to be handed to the safety service.');
    lines.push(`${PREFIX}queued_hashes ${queueCounts.queued}`);
    family('leased_hashes', 'gauge', 'Hashes handed over and waiting for their verdicts.');
    lines.push(`${PREFIX}leased_hashes ${queueCounts.leased}`);
    family(
      'last_poll_timestamp_seconds',
      'gauge',
      'Unix time of the last authenticated poll; 0 if none since start.'
    );
    lines.push(`${PREFIX}last_poll_timestamp_seconds ${this.#lastPollSeconds}`);
    for (const [name, [label, values, help]] of Object.entries(LABELLED)) {
      family(`${name}_total`, 'counter', help);
      for (const value of values) {
        lines.push(
          `${PREFIX}${name}_total{${label}="${value}"} ${this.#counts.get(`${name}:${value}`)}`
        );
      }
    }
    family(
      'egress_refused_total',
      'counter',
      'Outbound connection attempts the guard refused; any value above 0 is a defect.'
    );
    lines.push(`${PREFIX}egress_refused_total ${this.#egressRefused()}`);
    family('metrics_written_timestamp_seconds', 'gauge', 'Unix time this exposition was rendered.');
    lines.push(`${PREFIX}metrics_written_timestamp_seconds ${Math.floor(this.#now() / 1000)}`);
    return `${lines.join('\n')}\n`;
  }
}

module.exports = { HostMetrics, PREFIX };
