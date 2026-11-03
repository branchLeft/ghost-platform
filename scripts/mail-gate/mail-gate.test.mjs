// The mail gate, proven both ways against the built candidate image. Green: a
// correct image sends through its spool and the gate passes. Red (the control):
// the same image with its transactional host pointed away from the spool, which
// the gate must refuse while Ghost's own health still answers 200.
// Needs Docker. CI runs the pinned spool; locally set MAIL_GATE_SPOOL_IMAGE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_SPOOL, runMailGate } from './mail-gate.mjs';

const IMAGE = process.env.MAIL_GATE_IMAGE || 'ghost-platform:ci';
const SPOOL = process.env.MAIL_GATE_SPOOL_IMAGE || PINNED_SPOOL;
const TIMEOUT = 360_000;

test(
  'a correct candidate sends a magic link and a newsletter through its spool, and passes',
  { timeout: TIMEOUT },
  async () => {
    const result = await runMailGate({ image: IMAGE, spoolImage: SPOOL });
    assert.equal(result.passed, true, JSON.stringify(result.checks, null, 2));
    assert.ok(result.durationMs > 0, 'the gate reports how long it took');
    console.log(`mail gate duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  }
);

test(
  'a candidate whose transactional host points away from the spool fails, while its health answers 200',
  { timeout: TIMEOUT },
  async () => {
    const result = await runMailGate({
      image: IMAGE,
      spoolImage: SPOOL,
      transactionalHost: 'nowhere.invalid',
      deadlineMs: 45_000,
    });
    assert.equal(result.passed, false, 'the gate must refuse a misrouted candidate');
    const health = result.checks.find((c) => c.name.includes('answers 200 on its own health path'));
    assert.ok(health?.ok, 'Ghost itself must be healthy: the failure is in mail, not in boot');
    const magicLink = result.checks.find((c) => c.name.includes('magic link is in the spool'));
    assert.equal(magicLink?.ok, false, 'the magic link must be missing from the spool');
  }
);
