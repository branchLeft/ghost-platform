'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The names, types and label values below are the contract an alert rule in
// another repository is written against. metrics.md is the reference; change
// both together or a rule quietly stops matching.
const METRIC_PREFIX = 'scanning_storage_';

const REFUSAL_REASONS = Object.freeze(['unconfigured', 'verdict', 'sealed']);
const CLASSIFICATIONS = Object.freeze([
  'csam',
  'harmful-abusive-material',
  'test',
  'no-known-match',
  'unavailable',
]);
// Anything a verdict source returns outside the vocabulary above lands here,
// so the label set stays bounded whatever a future source says.
const OTHER_CLASSIFICATION = 'other';
const ERROR_KINDS = Object.freeze(['timeout', 'error']);
const LATENCY_BUCKETS_SECONDS = Object.freeze([0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5]);

const DEFAULT_EXPORT_INTERVAL_MS = 15_000;
const TEXTFILE_SUFFIX = '.prom';
const MISCONFIGURED_TOKEN = 'SCANNER_METRICS_MISCONFIGURED';

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(pairs) {
  const rendered = pairs
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`);
  return rendered.length > 0 ? `{${rendered.join(',')}}` : '';
}

function seededCounts(values) {
  return new Map(values.map((value) => [value, 0]));
}

// Counters and gauges a decorator reports, rendered as Prometheus text
// exposition. Every record method swallows its own failure: a metric must
// never be the reason an upload fails.
class ScannerMetrics {
  constructor({ tenant = null, now = Date.now } = {}) {
    this.tenant = tenant;
    this.now = now;
    this.refused = seededCounts(REFUSAL_REASONS);
    this.verdicts = seededCounts([...CLASSIFICATIONS, OTHER_CLASSIFICATION]);
    this.errors = seededCounts(ERROR_KINDS);
    this.unconfiguredInstances = 0;
    this.heldSources = [];
    this.latencyBuckets = LATENCY_BUCKETS_SECONDS.map(() => 0);
    this.latencyCount = 0;
    this.latencySum = 0;
  }

  recordRefusal(reason) {
    this.#safely(() => {
      const key = this.refused.has(reason) ? reason : null;
      if (key !== null) this.refused.set(key, this.refused.get(key) + 1);
    });
  }

  recordVerdict(classification) {
    this.#safely(() => {
      const key = this.verdicts.has(classification) ? classification : OTHER_CLASSIFICATION;
      this.verdicts.set(key, this.verdicts.get(key) + 1);
    });
  }

  recordVerdictError(kind) {
    this.#safely(() => {
      if (this.errors.has(kind)) this.errors.set(kind, this.errors.get(kind) + 1);
    });
  }

  observeVerdictSeconds(seconds) {
    this.#safely(() => {
      if (!Number.isFinite(seconds) || seconds < 0) return;
      this.latencyCount += 1;
      this.latencySum += seconds;
      LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
        if (seconds <= bound) this.latencyBuckets[index] += 1;
      });
    });
  }

  recordUnconfiguredInstance() {
    this.#safely(() => {
      this.unconfiguredInstances += 1;
    });
  }

  // `source()` answers { count, oldestSinceMs, stuck } for one hold registry.
  addHeldSource(source) {
    if (typeof source === 'function') this.heldSources.push(source);
  }

  #safely(fn) {
    try {
      fn();
    } catch {
      // Deliberately empty: see the class comment.
    }
  }

  #heldTotals() {
    let count = 0;
    let stuck = 0;
    let oldestSinceMs = null;
    for (const source of this.heldSources) {
      try {
        const reading = source();
        count += Number(reading.count) || 0;
        stuck += Number(reading.stuck) || 0;
        if (
          Number.isFinite(reading.oldestSinceMs) &&
          (oldestSinceMs === null || reading.oldestSinceMs < oldestSinceMs)
        ) {
          oldestSinceMs = reading.oldestSinceMs;
        }
      } catch {
        // A source that cannot be read contributes nothing rather than
        // failing the whole exposition.
      }
    }
    return { count, stuck, oldestSinceMs };
  }

  render() {
    const nowMs = this.now();
    const held = this.#heldTotals();
    const ageSeconds =
      held.oldestSinceMs === null ? 0 : Math.max(0, (nowMs - held.oldestSinceMs) / 1000);
    const tenant = ['tenant', this.tenant];
    const labels = (...extra) => renderLabels([tenant, ...extra]);
    const lines = [];
    const family = (name, type, help) => {
      lines.push(
        `# HELP ${METRIC_PREFIX}${name} ${help}`,
        `# TYPE ${METRIC_PREFIX}${name} ${type}`
      );
    };

    family(
      'unconfigured_instances',
      'gauge',
      'Adapter instances in this process with no verdict source, which refuse every new upload.'
    );
    lines.push(`${METRIC_PREFIX}unconfigured_instances${labels()} ${this.unconfiguredInstances}`);

    family('uploads_refused_total', 'counter', 'Uploads refused at the request, by reason.');
    for (const [reason, value] of this.refused) {
      lines.push(`${METRIC_PREFIX}uploads_refused_total${labels(['reason', reason])} ${value}`);
    }

    family(
      'verdicts_total',
      'counter',
      'Verdict outcomes by classification; timeouts and errors count here as unavailable.'
    );
    for (const [classification, value] of this.verdicts) {
      lines.push(
        `${METRIC_PREFIX}verdicts_total${labels(['classification', classification])} ${value}`
      );
    }

    family('verdict_errors_total', 'counter', 'Verdict requests that timed out or threw.');
    for (const [kind, value] of this.errors) {
      lines.push(`${METRIC_PREFIX}verdict_errors_total${labels(['kind', kind])} ${value}`);
    }

    family('verdict_duration_seconds', 'histogram', 'Time spent waiting for a verdict.');
    LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
      lines.push(
        `${METRIC_PREFIX}verdict_duration_seconds_bucket${labels(['le', String(bound)])} ${this.latencyBuckets[index]}`
      );
    });
    lines.push(
      `${METRIC_PREFIX}verdict_duration_seconds_bucket${labels(['le', '+Inf'])} ${this.latencyCount}`,
      `${METRIC_PREFIX}verdict_duration_seconds_sum${labels()} ${this.latencySum}`,
      `${METRIC_PREFIX}verdict_duration_seconds_count${labels()} ${this.latencyCount}`
    );

    family('held_uploads', 'gauge', 'Uploads accepted and held unserved, waiting for a verdict.');
    lines.push(`${METRIC_PREFIX}held_uploads${labels()} ${held.count}`);

    family(
      'held_oldest_age_seconds',
      'gauge',
      'Age of the oldest held upload; 0 when none is held.'
    );
    lines.push(`${METRIC_PREFIX}held_oldest_age_seconds${labels()} ${ageSeconds}`);

    family('held_stuck', 'gauge', 'Holds that stopped retrying and need an operator.');
    lines.push(`${METRIC_PREFIX}held_stuck${labels()} ${held.stuck}`);

    family('metrics_written_timestamp_seconds', 'gauge', 'Unix time this exposition was rendered.');
    lines.push(
      `${METRIC_PREFIX}metrics_written_timestamp_seconds${labels()} ${Math.floor(nowMs / 1000)}`
    );

    return `${lines.join('\n')}\n`;
  }
}

// Write-then-rename in the same directory, so a reader never sees half a
// file. The temporary name does not end in .prom, so a collector skips it.
function writeTextfileAtomic(file, text) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, text, { mode: 0o644 });
  fs.renameSync(temporary, file);
}

// Starts the periodic textfile export and returns its stop function. Never
// throws: a failing export is logged on its first failure and again after a
// recovery, and the adapter keeps serving.
function startTextfileExport(
  metrics,
  { filePath, intervalMs = DEFAULT_EXPORT_INTERVAL_MS, logger = console }
) {
  let failing = false;
  const writeOnce = () => {
    try {
      writeTextfileAtomic(filePath, metrics.render());
      failing = false;
    } catch (err) {
      if (!failing) {
        logger.error(
          `ScanningStorageAdapter: could not write the metrics textfile ${filePath}`,
          err
        );
      }
      failing = true;
    }
  };
  writeOnce();
  const timer = setInterval(writeOnce, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

let processMetrics = null;
let exportedTo = null;

// One registry per process: Ghost builds one decorator per storage feature
// in the same process, and they all report into this one.
function getProcessMetrics() {
  if (processMetrics === null) processMetrics = new ScannerMetrics();
  return processMetrics;
}

// Export is off unless both keys are present and well formed. A half-set
// configuration is reported and exports nothing: a series without its tenant
// label would collide with every other tenant's on the same host.
function configureProcessExport(config = {}, logger = console, metrics = getProcessMetrics()) {
  const filePath = config.metricsTextfilePath;
  const tenant = config.metricsTenant;
  const hasPath = typeof filePath === 'string' && filePath.length > 0;
  const hasTenant = typeof tenant === 'string' && tenant.length > 0;
  if (!hasPath && !hasTenant) return false;
  if (!hasPath || !hasTenant || !filePath.endsWith(TEXTFILE_SUFFIX) || !path.isAbsolute(filePath)) {
    logger.error(
      `ScanningStorageAdapter: ${MISCONFIGURED_TOKEN}: metricsTextfilePath must be an absolute path ending in ${TEXTFILE_SUFFIX} and metricsTenant must be set together; no metrics are exported`
    );
    return false;
  }
  if (exportedTo !== null) {
    if (exportedTo !== filePath) {
      logger.error(
        `ScanningStorageAdapter: ${MISCONFIGURED_TOKEN}: this process already exports to ${exportedTo}; ${filePath} is ignored`
      );
    }
    return false;
  }
  exportedTo = filePath;
  metrics.tenant = tenant;
  startTextfileExport(metrics, { filePath, logger });
  return true;
}

module.exports = {
  METRIC_PREFIX,
  REFUSAL_REASONS,
  CLASSIFICATIONS,
  OTHER_CLASSIFICATION,
  ERROR_KINDS,
  LATENCY_BUCKETS_SECONDS,
  MISCONFIGURED_TOKEN,
  ScannerMetrics,
  writeTextfileAtomic,
  startTextfileExport,
  getProcessMetrics,
  configureProcessExport,
};
