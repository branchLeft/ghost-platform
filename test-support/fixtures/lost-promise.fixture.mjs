// Run as a child process by the harness self-test, never collected by a
// glob. FIXTURE_MODE=bare leaves a setup promise unsettled; guarded runs the
// same hang inside runStep.
import { before, describe, it } from 'node:test';
import { runStep } from '../image-harness.mjs';

const hang = () => new Promise(() => {});

describe('suite whose setup hangs', () => {
  before(async () => {
    if (process.env.FIXTURE_MODE === 'guarded') {
      await runStep('boot ghost', hang, { deadlineMs: 300 });
    } else {
      await hang();
    }
  });

  it('first', () => {});
  it('second', () => {});
});
