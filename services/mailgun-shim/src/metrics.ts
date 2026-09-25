import type { ShimStore } from './store.js';

/**
 * Producer-side age metric (LLD-8 §03b): published by the spool itself,
 * not read back from whatever drains it, so a drainer that has stopped —
 * or one that keeps polling but never acking — shows up here as a growing
 * number regardless of what it reports about itself. Hand-rolled Prometheus
 * text exposition rather than a client library: one gauge doesn't earn a
 * new dependency, and the format is four lines.
 */
export function renderMetrics(
  store: ShimStore,
  now: () => number = () => Date.now() / 1000
): string {
  const ageSeconds = store.oldestUndrainedAgeSeconds(now());
  const undrained = store.countUndrainedRecipients();

  const lines = [
    '# HELP mailgun_shim_oldest_undrained_age_seconds Age in seconds of the oldest recipient not yet acknowledged by a drainer. 0 when the queue is empty.',
    '# TYPE mailgun_shim_oldest_undrained_age_seconds gauge',
    `mailgun_shim_oldest_undrained_age_seconds ${ageSeconds ?? 0}`,
    '# HELP mailgun_shim_undrained_recipients Recipients currently pending or held, awaiting a drain acknowledgement.',
    '# TYPE mailgun_shim_undrained_recipients gauge',
    `mailgun_shim_undrained_recipients ${undrained}`,
  ];
  return lines.join('\n') + '\n';
}
