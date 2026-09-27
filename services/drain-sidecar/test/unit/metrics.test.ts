import { describe, expect, it } from 'vitest';
import { renderMetrics } from '../../src/metrics.js';
import { deriveVersionState } from '../../src/versionState.js';

describe('renderMetrics()', () => {
  it('always reports the drain flag itself', () => {
    const text = renderMetrics(
      true,
      deriveVersionState({ intended: null, rawReported: null, drained: true })
    );
    expect(text).toContain('drain_sidecar_drained 1');

    const clearText = renderMetrics(
      false,
      deriveVersionState({ intended: null, rawReported: null, drained: false })
    );
    expect(clearText).toContain('drain_sidecar_drained 0');
  });

  it('reports the version-info gauge when undrained and Ghost answered', () => {
    const state = deriveVersionState({ intended: '6.55.0', rawReported: '6.55.0', drained: false });
    const text = renderMetrics(false, state);
    expect(text).toContain('drain_sidecar_ghost_version_info{version="6.55.0"} 1');
    expect(text).toContain('drain_sidecar_version_match 1');
  });

  it('reports a mismatch as 0, not by omitting the gauge', () => {
    const state = deriveVersionState({ intended: '6.56.0', rawReported: '6.55.0', drained: false });
    const text = renderMetrics(false, state);
    expect(text).toContain('drain_sidecar_version_match 0');
  });

  it('omits both version gauges entirely for a drained colour -- absence, not a zero, is the drained answer', () => {
    const state = deriveVersionState({ intended: '6.56.0', rawReported: '6.55.0', drained: true });
    const text = renderMetrics(true, state);
    expect(text).not.toContain('drain_sidecar_ghost_version_info');
    expect(text).not.toContain('drain_sidecar_version_match');
  });

  it('omits the match gauge but keeps the version-info gauge when intent is unknown', () => {
    const state = deriveVersionState({ intended: null, rawReported: '6.55.0', drained: false });
    const text = renderMetrics(false, state);
    expect(text).toContain('drain_sidecar_ghost_version_info{version="6.55.0"} 1');
    expect(text).not.toContain('drain_sidecar_version_match');
  });

  it('is valid Prometheus text exposition -- one HELP and one TYPE line ahead of every sample', () => {
    const state = deriveVersionState({ intended: '6.55.0', rawReported: '6.55.0', drained: false });
    const lines = renderMetrics(false, state).trimEnd().split('\n');
    const sampleLines = lines.filter((line) => !line.startsWith('#'));
    for (const sample of sampleLines) {
      const metricName = sample.split(/[\s{]/)[0];
      expect(lines).toContain(`# TYPE ${metricName} gauge`);
    }
  });
});
