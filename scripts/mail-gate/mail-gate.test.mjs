// The mail gate, proven both ways against the built candidate image. Green: a
// correct image sends through its spool and the gate passes. Red (the controls):
// the same image with its transactional host, then its newsletter (bulk) base
// URL, pointed away from the spool; the gate must refuse each while Ghost's own
// health still answers 200. CI builds the image and a stand-in spool
// (.github/workflows/mail-gate-ci.yml); locally set MAIL_GATE_SPOOL_IMAGE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_SPOOL, runMailGate } from './mail-gate.mjs';

const IMAGE = process.env.MAIL_GATE_IMAGE || 'ghost-platform:ci';
const SPOOL = process.env.MAIL_GATE_SPOOL_IMAGE || PINNED_SPOOL;
const TIMEOUT = 360_000;
const RED_DEADLINE_MS = 45_000;

// One evidence line per check, so a job log shows what each case did.
function report(label, result) {
  for (const c of result.checks) {
    console.log(`${label}: ${c.ok ? 'PASS' : 'FAIL'}: ${c.name}`);
  }
  console.log(`${label}: gate ${result.passed ? 'passed' : 'FAILED'}`);
}

const find = (result, part) => result.checks.find((c) => c.name.includes(part));

test(
  'a correct candidate sends a magic link and a newsletter through its spool, and passes',
  { timeout: TIMEOUT },
  async () => {
    const result = await runMailGate({ image: IMAGE, spoolImage: SPOOL });
    report('green', result);
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
      deadlineMs: RED_DEADLINE_MS,
    });
    report('red-transactional', result);
    assert.equal(result.passed, false, 'the gate must refuse a misrouted candidate');
    assert.ok(
      find(result, 'answers 200 on its own health path')?.ok,
      'Ghost itself must be healthy: the failure is in mail, not in boot'
    );
    assert.equal(
      find(result, 'magic link is in the spool')?.ok,
      false,
      'the magic link must be missing from the spool'
    );
  }
);

test(
  'a candidate whose newsletter base URL points away from the spool fails, while its health answers 200 and its magic link arrives',
  { timeout: TIMEOUT },
  async () => {
    const result = await runMailGate({
      image: IMAGE,
      spoolImage: SPOOL,
      bulkBaseUrl: 'http://nowhere.invalid:8080/v3',
      deadlineMs: RED_DEADLINE_MS,
    });
    report('red-bulk', result);
    assert.equal(
      result.passed,
      false,
      'the gate must refuse a candidate with a misrouted newsletter path'
    );
    assert.ok(
      find(result, 'answers 200 on its own health path')?.ok,
      'Ghost itself must be healthy: the failure is in mail, not in boot'
    );
    assert.equal(
      find(result, 'magic link is in the spool')?.ok,
      true,
      'the transactional path is intact: only the newsletter path is misrouted'
    );
    assert.equal(
      find(result, 'newsletter is in the spool')?.ok,
      false,
      'the newsletter must be missing from the spool'
    );
  }
);
