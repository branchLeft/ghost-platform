import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(readdirSync(join(dir, 'nested')).sort()).toEqual([
      'submitted.json',
      'submitted.json.initialised',
    ]);
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

describe('createSubmittedTracker stateLost', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-state-lost-'));
    statePath = join(dir, 'state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is false for a tracker with no state file yet, and for a memory-only one', () => {
    expect(createSubmittedTracker(1000).stateLost).toBe(false);
    expect(createSubmittedTracker(1000, () => 0, { statePath }).stateLost).toBe(false);
  });

  it('is true when the state file is corrupt, and for a restart after that', () => {
    writeFileSync(statePath, '{ not json');
    const tracker = createSubmittedTracker(1000, () => 0, { statePath, onError: () => {} });
    expect(tracker.stateLost).toBe(true);
    // The empty state was written back; a restart must not read it as a clean one.
    expect(createSubmittedTracker(1000, () => 0, { statePath }).stateLost).toBe(true);
  });

  it('is true when the state file cannot be read', () => {
    mkdirSync(statePath);
    const tracker = createSubmittedTracker(1000, () => 0, { statePath, onError: () => {} });
    expect(tracker.stateLost).toBe(true);
  });

  it('ends one TTL after the loss, when no forgotten id could still matter', () => {
    let now = 5000;
    writeFileSync(statePath, '{ not json');
    const tracker = createSubmittedTracker(1000, () => now, { statePath, onError: () => {} });
    expect(tracker.stateLost).toBe(true);
    now = 5999;
    expect(tracker.stateLost).toBe(true);
    now = 6000;
    expect(tracker.stateLost).toBe(false);
  });
});

describe('createSubmittedTracker with a state file that has vanished', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-state-vanished-'));
    statePath = join(dir, 'state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const markerOf = (): string => `${statePath}.initialised`;

  it('writes a marker on the first successful save, and not before', () => {
    const tracker = createSubmittedTracker(1000, () => 0, { statePath });
    expect(existsSync(markerOf())).toBe(false);
    tracker.markSubmitted('m1');
    expect(existsSync(markerOf())).toBe(true);
  });

  it('is lost, and says so, when the file is gone but the marker is there', () => {
    createSubmittedTracker(1000, () => 0, { statePath }).markSubmitted('m1');
    rmSync(statePath);
    const errors: Error[] = [];
    const tracker = createSubmittedTracker(1000, () => 0, {
      statePath,
      onError: (e) => errors.push(e),
    });
    expect(tracker.stateLost).toBe(true);
    expect(tracker.has('m1')).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('records the loss in the file, so a restart still reads it as lost', () => {
    createSubmittedTracker(1000, () => 0, { statePath }).markSubmitted('m1');
    rmSync(statePath);
    createSubmittedTracker(1000, () => 0, { statePath, onError: () => {} });
    expect(createSubmittedTracker(1000, () => 0, { statePath }).stateLost).toBe(true);
  });

  it('ends the loss one TTL after it, like a corrupt file', () => {
    let now = 5000;
    createSubmittedTracker(1000, () => now, { statePath }).markSubmitted('m1');
    rmSync(statePath);
    const tracker = createSubmittedTracker(1000, () => now, { statePath, onError: () => {} });
    expect(tracker.stateLost).toBe(true);
    now = 6000;
    expect(tracker.stateLost).toBe(false);
  });

  it('is not lost on a first run: neither file nor marker has ever been written', () => {
    const errors: Error[] = [];
    const tracker = createSubmittedTracker(1000, () => 0, {
      statePath,
      onError: (e) => errors.push(e),
    });
    expect(tracker.stateLost).toBe(false);
    expect(errors).toEqual([]);
  });

  it('reads a file with no marker as an upgrade, not a loss, and writes the marker', () => {
    writeFileSync(statePath, JSON.stringify({ version: 1, submitted: { m1: 0 } }));
    const tracker = createSubmittedTracker(1000, () => 0, { statePath });
    expect(tracker.has('m1')).toBe(true);
    expect(existsSync(markerOf())).toBe(true);
    rmSync(statePath);
    expect(createSubmittedTracker(1000, () => 0, { statePath, onError: () => {} }).stateLost).toBe(
      true
    );
  });

  it('keeps a memory-only tracker clean: it writes no marker', () => {
    const tracker = createSubmittedTracker(1000, () => 0);
    tracker.markSubmitted('m1');
    expect(tracker.stateLost).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
