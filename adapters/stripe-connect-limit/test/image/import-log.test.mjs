// No Docker needed. See stripe-refusal.image.test.md, "Why arm C reads the log".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importFailureSection, readUntilStable } from './import-log.mjs';

const M = 'Content import was unsuccessful';

describe('importFailureSection', () => {
  it('returns the section of the failure after the ones already counted', () => {
    const log = `${M} first reason A\nnoise\n${M} second reason B\nmore`;
    assert.equal(importFailureSection(log, M, 0), `${M} first reason A\nnoise\n`);
    assert.equal(importFailureSection(log, M, 1), `${M} second reason B\nmore`);
  });

  it('is not moved by a later failure that is not this import', () => {
    const log = `${M} reason of ours\n${M} reason of someone else`;
    const ours = importFailureSection(log, M, 0);
    assert.ok(ours.includes('reason of ours'));
    assert.ok(!ours.includes('someone else'));
  });

  it('is not moved by a long log, or a later failure, after this one', () => {
    const log = `${M} the refusal\n${'x'.repeat(100000)}\n${M} a later failure`;
    const ours = importFailureSection(log, M, 0);
    assert.ok(ours.startsWith(`${M} the refusal`));
    assert.ok(!ours.includes('a later failure'));
  });

  it('returns nothing when that failure was not logged', () => {
    assert.equal(importFailureSection(`${M} only one`, M, 1), '');
    assert.equal(importFailureSection('', M, 0), '');
  });
});

describe('readUntilStable', () => {
  const noSleep = async () => {};

  it('returns the text once two reads in a row agree, not the first read', async () => {
    const reads = ['start', 'start plus the reason lines', 'start plus the reason lines'];
    let i = 0;
    const got = await readUntilStable(() => reads[Math.min(i++, reads.length - 1)], {
      sleep: noSleep,
    });
    assert.equal(got, 'start plus the reason lines');
  });

  it('gives up after maxMs and returns the latest read', async () => {
    let i = 0;
    const got = await readUntilStable(() => `grows ${i++}`, {
      intervalMs: 100,
      maxMs: 300,
      sleep: noSleep,
    });
    assert.match(got, /^grows \d+$/);
    assert.equal(i, 4);
  });
});
