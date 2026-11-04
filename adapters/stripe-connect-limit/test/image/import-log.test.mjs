// No Docker needed. See stripe-refusal.image.test.md, "Why arm C reads the log".
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importFailureSection } from './import-log.mjs';

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

  it('is not moved by a long log after the failure', () => {
    const log = `${M} the refusal\n${'x'.repeat(100000)}`;
    assert.ok(importFailureSection(log, M, 0).startsWith(`${M} the refusal`));
  });

  it('returns nothing when that failure was not logged', () => {
    assert.equal(importFailureSection(`${M} only one`, M, 1), '');
    assert.equal(importFailureSection('', M, 0), '');
  });
});
