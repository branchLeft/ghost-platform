import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSubmittedTracker } from '../../src/dedupe.js';

describe('createSubmittedTracker', () => {
  it('has() is false before markSubmitted and true after', () => {
    const tracker = createSubmittedTracker(1000);
    expect(tracker.has('m1')).toBe(false);
    tracker.markSubmitted('m1');
    expect(tracker.has('m1')).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it('sweep() evicts entries older than the TTL and keeps newer ones', () => {
    let now = 1000;
    const tracker = createSubmittedTracker(500, () => now);
    tracker.markSubmitted('old');
    now = 1600; // 600ms later -- past the 500ms TTL
    tracker.markSubmitted('new');
    tracker.sweep();
    expect(tracker.has('old')).toBe(false);
    expect(tracker.has('new')).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it('sweep() is a no-op when nothing has expired', () => {
    let now = 0;
    const tracker = createSubmittedTracker(10_000, () => now);
    tracker.markSubmitted('m1');
    now = 100;
    tracker.sweep();
    expect(tracker.has('m1')).toBe(true);
  });
});

describe('createSubmittedTracker with a state file', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dedupe-state-'));
    statePath = join(dir, 'nested', 'submitted.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a new tracker on the same file still has an id the first one marked', () => {
    createSubmittedTracker(1000, () => 0, { statePath }).markSubmitted('m1');
    const restarted = createSubmittedTracker(1000, () => 0, { statePath });
    expect(restarted.has('m1')).toBe(true);
    expect(restarted.has('other')).toBe(false);
  });

  it('leaves no temp file behind after a write', () => {
    createSubmittedTracker(1000, () => 0, { statePath }).markSubmitted('m1');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['submitted.json']);
  });

  it('a sweep that evicts is persisted, so an expired id stays gone after a restart', () => {
    let now = 0;
    const tracker = createSubmittedTracker(500, () => now, { statePath });
    tracker.markSubmitted('old');
    now = 1000;
    tracker.markSubmitted('new');
    tracker.sweep();
    const restarted = createSubmittedTracker(500, () => now, { statePath });
    expect(restarted.has('old')).toBe(false);
    expect(restarted.has('new')).toBe(true);
  });

  it('a missing file starts empty without reporting an error', () => {
    const errors: Error[] = [];
    const tracker = createSubmittedTracker(1000, () => 0, {
      statePath,
      onError: (e) => errors.push(e),
    });
    expect(tracker.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a corrupt file starts empty, reports it, and is replaced by the next write', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(statePath, '{"version":1,"submitted":{"m1"');
    const errors: Error[] = [];
    const tracker = createSubmittedTracker(1000, () => 0, {
      statePath,
      onError: (e) => errors.push(e),
    });
    expect(tracker.has('m1')).toBe(false);
    expect(errors).toHaveLength(1);
    tracker.markSubmitted('m2');
    expect(createSubmittedTracker(1000, () => 0, { statePath }).has('m2')).toBe(true);
  });

  it('an unwritable state path is reported but the id is still remembered in memory', () => {
    mkdirSync(join(dir, 'nested'));
    // A directory at the file's own path makes the final rename fail.
    mkdirSync(statePath);
    const errors: Error[] = [];
    const tracker = createSubmittedTracker(1000, () => 0, {
      statePath,
      onError: (e) => errors.push(e),
    });
    errors.length = 0;
    expect(() => tracker.markSubmitted('m1')).not.toThrow();
    expect(tracker.has('m1')).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});
