import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSubmittedTracker, MAX_AWAITING_ACK_MS } from '../../src/dedupe.js';

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

describe('ids submitted and awaiting an ack', () => {
  const HOUR = 60 * 60 * 1000;

  it('survives past the TTL until the ack lands, so a batch longer than the TTL cannot resend', () => {
    let now = 0;
    const tracker = createSubmittedTracker(HOUR, () => now);
    tracker.markSubmitted('first-of-batch', true);
    now = 3 * HOUR; // the batch outlasted the TTL at a low ramp rate
    tracker.sweep();
    expect(tracker.has('first-of-batch')).toBe(true);
  });

  it('expires on the normal TTL once acked, counted from the ack', () => {
    let now = 0;
    const tracker = createSubmittedTracker(HOUR, () => now);
    tracker.markSubmitted('m1', true);
    now = 3 * HOUR;
    tracker.markAcked(['m1']);
    now = 3 * HOUR + HOUR - 1;
    tracker.sweep();
    expect(tracker.has('m1')).toBe(true);
    now = 3 * HOUR + HOUR + 1;
    tracker.sweep();
    expect(tracker.has('m1')).toBe(false);
  });

  it('is evicted after the hard bound even if no ack ever lands', () => {
    let now = 0;
    const tracker = createSubmittedTracker(HOUR, () => now);
    tracker.markSubmitted('lost', true);
    now = MAX_AWAITING_ACK_MS - 1;
    tracker.sweep();
    expect(tracker.has('lost')).toBe(true);
    now = MAX_AWAITING_ACK_MS + 1;
    tracker.sweep();
    expect(tracker.has('lost')).toBe(false);
  });

  it('an id marked without the awaiting flag keeps the plain TTL behaviour', () => {
    let now = 0;
    const tracker = createSubmittedTracker(HOUR, () => now);
    tracker.markSubmitted('plain');
    now = HOUR + 1;
    tracker.sweep();
    expect(tracker.has('plain')).toBe(false);
  });

  it('markAcked ignores an id it never saw', () => {
    const tracker = createSubmittedTracker(HOUR, () => 0);
    expect(() => tracker.markAcked(['never-seen'])).not.toThrow();
    expect(tracker.size).toBe(0);
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
  it('an id awaiting an ack survives a restart past the TTL, and not once it is acked', () => {
    const HOUR = 60 * 60 * 1000;
    let now = 0;
    const first = createSubmittedTracker(HOUR, () => now, { statePath });
    first.markSubmitted('sent-before-restart', true);
    first.markSubmitted('acked-before-restart', true);
    first.markAcked(['acked-before-restart']);
    now = 3 * HOUR;
    const restarted = createSubmittedTracker(HOUR, () => now, { statePath });
    restarted.sweep();
    expect(restarted.has('sent-before-restart')).toBe(true);
    expect(restarted.has('acked-before-restart')).toBe(false);
  });

  it('a file written before awaiting-ack existed loads, its ids treated as acked', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(statePath, JSON.stringify({ version: 1, submitted: { old: 0 } }));
    const tracker = createSubmittedTracker(500, () => 1000, { statePath });
    expect(tracker.has('old')).toBe(true);
    tracker.sweep();
    expect(tracker.has('old')).toBe(false);
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
