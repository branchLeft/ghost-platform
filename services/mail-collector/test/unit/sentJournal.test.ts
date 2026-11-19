import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSentJournal, outcomeIdFor } from '../../src/sentJournal.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

describe('sent-id journal', () => {
  let dir: string;
  let path: string;
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-sent-journal-'));
    path = join(dir, 'state', 'sent.ndjson');
    errors = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (now = NOW, ttlMs = 35 * DAY, extra: { maxEntries?: number } = {}) =>
    createSentJournal({
      path,
      ttlMs,
      now: () => now,
      onError: (e) => errors.push(e.message),
      ...extra,
    });

  it('places a value it recorded, with the spool it came from, and nothing it did not', () => {
    const journal = open();
    expect(journal.record({ targetId: 'tenant-a', id: 'msg-1', drainCount: 2, atMs: NOW })).toBe(
      true
    );
    expect(journal.lookup('msg-1.2')).toEqual({
      outcomeId: 'msg-1.2',
      targetId: 'tenant-a',
      id: 'msg-1',
      drainCount: 2,
      atMs: NOW,
    });
    expect(journal.lookup('msg-1.3')).toBeUndefined();
    expect(journal.lookup('msg-2.2')).toBeUndefined();
  });

  it('uses only characters the receiver accepts in an outcome id', () => {
    expect(outcomeIdFor({ id: 'a1b2-c3', drainCount: 4 })).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
  });

  it('survives a restart', () => {
    open().record({ targetId: 'tenant-a', id: 'msg-1', drainCount: 1, atMs: NOW });
    const reopened = open(NOW + DAY);
    expect(reopened.lookup('msg-1.1')?.targetId).toBe('tenant-a');
    expect(errors).toEqual([]);
  });

  it('forgets an entry past the TTL, on sweep and on load, and rewrites the file whole', () => {
    const journal = open(NOW, 10 * DAY);
    journal.record({ targetId: 'tenant-a', id: 'old', drainCount: 1, atMs: NOW - 11 * DAY });
    journal.record({ targetId: 'tenant-a', id: 'new', drainCount: 1, atMs: NOW });
    journal.sweep();
    expect(journal.lookup('old.1')).toBeUndefined();
    expect(readFileSync(path, 'utf8')).not.toContain('"old"');
    expect(open(NOW, 10 * DAY).lookup('new.1')).toBeDefined();

    const stale = open(NOW + 20 * DAY, 10 * DAY);
    expect(stale.size).toBe(0);
  });

  it('skips a torn last line left by a crash and keeps every whole line', () => {
    open().record({ targetId: 'tenant-a', id: 'msg-1', drainCount: 1, atMs: NOW });
    appendFileSync(path, '{"outcomeId":"msg-2.1","targetId":"te');
    const reopened = open();
    expect(reopened.lookup('msg-1.1')).toBeDefined();
    expect(reopened.lookup('msg-2.1')).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('does not trust an entry whose value disagrees with its own fields', () => {
    open().record({ targetId: 'tenant-a', id: 'msg-1', drainCount: 1, atMs: NOW });
    appendFileSync(
      path,
      `${JSON.stringify({ outcomeId: 'victim.1', targetId: 'tenant-b', id: 'other', drainCount: 1, atMs: NOW })}\n`
    );
    const reopened = open();
    expect(reopened.lookup('victim.1')).toBeUndefined();
    expect(errors).toContain('sent journal has an unrecognised entry');
  });

  it('leaves a file of an unknown version untouched and keeps nothing new in it', () => {
    mkdirSync(dirname(path), { recursive: true });
    const foreign = `${JSON.stringify({ version: 99 })}\nsomething\n`;
    writeFileSync(path, foreign);
    const journal = open();
    expect(journal.record({ targetId: 't', id: 'm', drainCount: 1, atMs: NOW })).toBe(false);
    journal.sweep();
    expect(readFileSync(path, 'utf8')).toBe(foreign);
    expect(errors).toContain('sent journal has an unrecognised version');
  });

  it('refuses a new entry when full instead of forgetting an old one', () => {
    const journal = open(NOW, 35 * DAY, { maxEntries: 1 });
    expect(journal.record({ targetId: 't', id: 'a', drainCount: 1, atMs: NOW })).toBe(true);
    expect(journal.record({ targetId: 't', id: 'b', drainCount: 1, atMs: NOW })).toBe(false);
    expect(journal.lookup('a.1')).toBeDefined();
    expect(errors).toContain('sent journal is full');
  });

  it('answers false, not an exception, when the file cannot be written', () => {
    const journal = createSentJournal({
      path: join(dir, 'a-file', 'sent.ndjson'),
      ttlMs: DAY,
      onError: (e) => errors.push(e.message),
    });
    writeFileSync(join(dir, 'a-file'), 'not a directory');
    expect(journal.record({ targetId: 't', id: 'a', drainCount: 1, atMs: Date.now() })).toBe(false);
    expect(journal.lookup('a.1')).toBeUndefined();
  });

  it('works memory-only with no path', () => {
    const journal = createSentJournal({ ttlMs: DAY, now: () => NOW });
    journal.record({ targetId: 't', id: 'a', drainCount: 1, atMs: NOW });
    expect(journal.lookup('a.1')?.targetId).toBe('t');
  });
});
