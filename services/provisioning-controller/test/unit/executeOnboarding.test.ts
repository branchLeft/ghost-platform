import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalRequiredError,
  ApprovalScopeError,
  InvalidRunOptionsError,
  STEP_IDS,
  StateStoreUnreadableError,
  StateStoreWriteError,
  executeOnboarding,
  planOnboarding,
} from '../../src/index.js';
import { APPROVAL, ENTRY, World } from '../support/doubles.js';

const key = (id: string): string => `${ENTRY.tenantId}/${id}`;
const ALL_KEYS = STEP_IDS.map(key);
const FULL_RUN_APPENDS = STEP_IDS.length * 2 + 1;

describe('executeOnboarding: a normal run', () => {
  it('runs every planned step once, in dependency order, from the approval alone', async () => {
    const world = new World();
    const plan = await planOnboarding(APPROVAL.approvalId, world.ports());
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());

    expect(result.status).toBe('complete');
    expect(result.tenantId).toBe(ENTRY.tenantId);
    expect(result.ran).toEqual(ALL_KEYS);
    expect(result.skipped).toEqual([]);
    expect(world.calls.map((c) => c.request.key)).toEqual(ALL_KEYS);
    for (const step of plan.steps) {
      const call = world.calls.find((c) => c.request.key === step.key);
      expect(call?.entryPoint).toBe(step.entryPoint);
      expect(call?.request.inputs).toEqual(step.inputs);
      expect(call?.request.idempotencyKey).toBe(`${step.key}@${step.inputDigest}`);
    }
  });

  it('records each outcome durably before the next step starts', async () => {
    const world = new World();
    const violations: string[] = [];
    world.beforeCall = (request) => {
      const started = world.state.records.some(
        (r) => r.event === 'started' && r.key === request.key
      );
      if (!started) violations.push(`${request.key} acted before its started record`);
      const index = ALL_KEYS.indexOf(request.key);
      for (const earlier of ALL_KEYS.slice(0, index)) {
        if (!world.state.completeKeys().includes(earlier)) {
          violations.push(`${request.key} began before ${earlier} was recorded complete`);
        }
      }
    };
    await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(violations).toEqual([]);
    expect(world.state.records).toHaveLength(FULL_RUN_APPENDS);
    expect(world.state.records.at(-1)?.event).toBe('run-complete');
  });

  it('reports progress to the console, only after the state is recorded, and never the inputs', async () => {
    const world = new World();
    await executeOnboarding(APPROVAL.approvalId, world.ports());

    const types = world.events.map((e) => e.type);
    expect(types[0]).toBe('run-started');
    expect(types.at(-1)).toBe('run-complete');
    expect(types.filter((t) => t === 'step-started')).toHaveLength(STEP_IDS.length);
    expect(types.filter((t) => t === 'step-complete')).toHaveLength(STEP_IDS.length);
    world.events.forEach((event, i) => {
      if (event.type === 'step-complete') {
        expect(world.completeAtReport[i]).toContain(event.key);
      }
    });
    expect(JSON.stringify(world.events)).not.toContain('SLOT_PLACEHOLDER');
  });

  it('does nothing further when run again after it finished', async () => {
    const world = new World();
    await executeOnboarding(APPROVAL.approvalId, world.ports());
    const again = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(again.status).toBe('complete');
    expect(again.ran).toEqual([]);
    expect(again.skipped).toEqual(ALL_KEYS);
    expect(world.calls).toHaveLength(STEP_IDS.length);
  });

  it('carries completed steps across a fresh approval for the same tenant', async () => {
    const world = new World();
    world.state.failAppendsFrom = 9;
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      StateStoreWriteError
    );
    world.state.failAppendsFrom = undefined;
    world.approval = { ...APPROVAL, approvalId: 'APPROVAL_TWO_PLACEHOLDER' };
    const result = await executeOnboarding('APPROVAL_TWO_PLACEHOLDER', world.ports());
    expect(result.status).toBe('complete');
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});

describe('executeOnboarding: a killed run', () => {
  const killPoints = Array.from({ length: FULL_RUN_APPENDS }, (_, i) => i);

  it.each(killPoints)(
    'killed at record %i resumes and finishes without repeating a completed step',
    async (killAt) => {
      const world = new World();
      world.state.failAppendsFrom = killAt;
      await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
        StateStoreWriteError
      );
      const completeAtKill = world.state.completeKeys();

      world.state.failAppendsFrom = undefined;
      const resumed = await executeOnboarding(APPROVAL.approvalId, world.ports());

      expect(resumed.status).toBe('complete');
      expect(resumed.skipped).toEqual(completeAtKill);
      expect([...world.state.completeKeys()].sort()).toEqual([...ALL_KEYS].sort());
      for (const done of completeAtKill) expect(world.callCount(done)).toBe(1);
      for (const other of ALL_KEYS.filter((k) => !completeAtKill.includes(k))) {
        expect(world.callCount(other)).toBeGreaterThanOrEqual(1);
        expect(world.callCount(other)).toBeLessThanOrEqual(2);
      }
    }
  );

  it('re-runs only the step that was acted on but not recorded, under the same idempotency key', async () => {
    const world = new World();
    world.state.failOnEvent = 'complete';
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      StateStoreWriteError
    );
    expect(world.calls).toHaveLength(1);

    world.state.failOnEvent = undefined;
    await executeOnboarding(APPROVAL.approvalId, world.ports());
    const first = ALL_KEYS[0] ?? '';
    const runs = world.calls.filter((c) => c.request.key === first);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.request.idempotencyKey).toBe(runs[1]?.request.idempotencyKey);
    expect(world.calls).toHaveLength(STEP_IDS.length + 1);
  });

  it('acts on nothing when the record that precedes it cannot be written', async () => {
    const world = new World();
    world.state.failOnEvent = 'started';
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      StateStoreWriteError
    );
    expect(world.calls).toEqual([]);
  });

  it('fails closed, running nothing, when the state store cannot be read', async () => {
    const world = new World();
    world.state.failReads = new Error('UNREADABLE_PLACEHOLDER');
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      StateStoreUnreadableError
    );
    expect(world.calls).toEqual([]);
    expect(world.state.records).toEqual([]);
  });
});

describe('executeOnboarding: retry', () => {
  const target = key('create-database');

  it('retries a failing step with doubling backoff and records each failed attempt', async () => {
    const world = new World();
    world.failFirst.set(target, 2);
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());

    expect(result.status).toBe('complete');
    expect(world.callCount(target)).toBe(3);
    expect(world.sleeps).toEqual([1000, 2000]);
    const history = world.state.records.filter((r) => r.key === target).map((r) => r.event);
    expect(history).toEqual(['started', 'attempt-failed', 'attempt-failed', 'complete']);
    const retrying = world.events.filter((e) => e.type === 'step-retrying');
    expect(retrying.map((e) => e.delayMs)).toEqual([1000, 2000]);
  });

  it('stops the run with a recorded reason when the attempts run out, and starts nothing after', async () => {
    const world = new World();
    world.failAlways.add(target);
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());

    expect(result.status).toBe('stopped');
    expect(result.stoppedAt).toEqual({ key: target, reason: 'step-failed' });
    expect(world.callCount(target)).toBe(3);
    expect(world.sleeps).toEqual([1000, 2000]);
    expect(world.calls).toHaveLength(5);
    const failed = world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.key).toBe(target);
    expect(failed?.attempt).toBe(3);
    expect(failed?.reason).toContain('HOST_DOWN_PLACEHOLDER');
    expect(world.state.records.some((r) => r.event === 'run-complete')).toBe(false);
    expect(world.events.at(-1)?.type).toBe('step-failed');
  });

  it('caps the backoff and honours a custom attempt limit', async () => {
    const world = new World();
    world.failAlways.add(target);
    await executeOnboarding(APPROVAL.approvalId, world.ports(), {
      retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 25 },
    });
    expect(world.callCount(target)).toBe(5);
    expect(world.sleeps).toEqual([10, 20, 25, 25]);
  });

  it('does not retry a failure the host marks permanent', async () => {
    const world = new World();
    world.permanent.add(target);
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(result.status).toBe('stopped');
    expect(world.callCount(target)).toBe(1);
    expect(world.sleeps).toEqual([]);
    expect(world.state.records.find((r) => r.event === 'step-failed')?.reason).toContain(
      'PermanentStepError'
    );
  });

  it('resumes a stopped run with fresh attempts and finishes once the host recovers', async () => {
    const world = new World();
    world.failAlways.add(target);
    await executeOnboarding(APPROVAL.approvalId, world.ports());
    world.failAlways.clear();
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());

    expect(result.status).toBe('complete');
    expect(result.skipped).toEqual(ALL_KEYS.slice(0, 2));
    expect(world.callCount(target)).toBe(4);
    for (const other of ALL_KEYS.filter((k) => k !== target)) {
      expect(world.callCount(other)).toBe(1);
    }
  });

  it('rejects an unusable retry policy before touching anything', async () => {
    const world = new World();
    const err = await executeOnboarding(APPROVAL.approvalId, world.ports(), {
      retry: { maxAttempts: 0, baseDelayMs: -1, maxDelayMs: 0.5 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRunOptionsError);
    expect((err as InvalidRunOptionsError).fields).toEqual([
      'maxAttempts',
      'baseDelayMs',
      'maxDelayMs',
    ]);
    expect(world.calls).toEqual([]);
    expect(world.state.records).toEqual([]);
  });

  it('rejects a cap below the base delay', async () => {
    const world = new World();
    await expect(
      executeOnboarding(APPROVAL.approvalId, world.ports(), {
        retry: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 10 },
      })
    ).rejects.toBeInstanceOf(InvalidRunOptionsError);
  });
});

describe('executeOnboarding: host error text', () => {
  const target = key('create-database');
  const SECRET = `ghp_${'Q'.repeat(36)}`;
  const PASSWORD = 'hunter2zz';

  it('keeps a secret-shaped value in a thrown error out of the state record and the console', async () => {
    const world = new World();
    world.failWith.set(
      target,
      new Error(`login rejected for ${SECRET} with password=${PASSWORD} on host-one`)
    );
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());

    expect(result.status).toBe('stopped');
    const written = JSON.stringify(world.state.records);
    const reported = JSON.stringify(world.events);
    for (const text of [written, reported]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PASSWORD);
    }
    const failed = world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.reason).toContain('login rejected');
    expect(failed?.reason).toContain('host-one');
  });

  it('redacts the text of a failed attempt that is retried, in record and report alike', async () => {
    const world = new World();
    world.failWith.set(target, new Error(`busy token=${SECRET}`));
    await executeOnboarding(APPROVAL.approvalId, world.ports());
    const attempt = world.state.records.find((r) => r.event === 'attempt-failed');
    const retrying = world.events.find((e) => e.type === 'step-retrying');
    expect(attempt?.reason).toBeDefined();
    expect(retrying?.reason).toBeDefined();
    expect(attempt?.reason).not.toContain(SECRET);
    expect(retrying?.reason).not.toContain(SECRET);
  });

  it('does not let a secret straddle the 200-character cut', async () => {
    const world = new World();
    const lead = 'x '.repeat(90);
    world.failWith.set(target, new Error(`${lead}${SECRET}`));
    await executeOnboarding(APPROVAL.approvalId, world.ports());
    const failed = world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.reason).not.toContain('ghp_');
    expect(failed?.reason).not.toContain('QQQQQ');
  });
});

describe('executeOnboarding: a changed register', () => {
  it('refuses a step recorded complete under a different input digest, and never re-runs it', async () => {
    const world = new World();
    await executeOnboarding(APPROVAL.approvalId, world.ports());
    const callsBefore = world.calls.length;

    world.entry = { ...ENTRY, hostnames: ['host-three.example.invalid'] };
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());

    const changed = key('push-first-commit');
    expect(result.status).toBe('stopped');
    expect(result.stoppedAt).toEqual({ key: changed, reason: 'input-changed' });
    expect(result.skipped).toEqual(ALL_KEYS.slice(0, 7));
    expect(world.calls).toHaveLength(callsBefore);
    const refusal = world.state.records.find((r) => r.event === 'digest-mismatch');
    expect(refusal?.key).toBe(changed);
    expect(refusal?.reason).toContain('different input digest');
    expect(world.events.at(-1)?.type).toBe('step-refused');

    const again = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(again.stoppedAt?.key).toBe(changed);
    expect(world.calls).toHaveLength(callsBefore);
  });
});

describe('executeOnboarding: a register that changes during a run', () => {
  it('carries the whole run out on the plan it started with, and the next call catches the change', async () => {
    const world = new World();
    const plan = await planOnboarding(APPROVAL.approvalId, world.ports());
    world.afterCall = (count) => {
      if (count === 2) world.entry = { ...ENTRY, hostnames: ['host-three.example.invalid'] };
    };
    const first = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(first.status).toBe('complete');
    for (const step of plan.steps) {
      const call = world.calls.find((c) => c.request.key === step.key);
      expect(call?.request.idempotencyKey).toBe(`${step.key}@${step.inputDigest}`);
    }

    const callsBefore = world.calls.length;
    const next = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(next.status).toBe('stopped');
    expect(next.stoppedAt?.reason).toBe('input-changed');
    expect(world.calls).toHaveLength(callsBefore);
  });
});

describe('executeOnboarding: the approval gate', () => {
  it('runs nothing without a recorded approval, and records and reports the halt', async () => {
    const world = new World();
    world.approval = undefined;
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(world.calls).toEqual([]);
    expect(world.state.records.map((r) => r.event)).toEqual(['run-halted']);
    expect(world.state.records[0]?.approvalId).toBe(APPROVAL.approvalId);
    expect(world.events.map((e) => e.type)).toEqual(['run-halted']);
  });

  it('runs nothing when the approval leaves out any part of the one approval', async () => {
    const world = new World();
    world.approval = { ...APPROVAL, scopes: ['setup'] };
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalScopeError
    );
    expect(world.calls).toEqual([]);
  });

  it('stops a resumed run whose approval has been revoked, and runs nothing', async () => {
    const world = new World();
    world.state.failAppendsFrom = 9;
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      StateStoreWriteError
    );
    const callsAtKill = world.calls.length;

    world.state.failAppendsFrom = undefined;
    world.approval = undefined;
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(world.calls).toHaveLength(callsAtKill);
    expect(world.state.records.at(-1)?.event).toBe('run-halted');

    world.approval = APPROVAL;
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(result.status).toBe('complete');
  });

  it('does not start another step once the approval is no longer recorded', async () => {
    const world = new World();
    world.afterCall = (count) => {
      if (count === 3) world.approval = undefined;
    };
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(world.calls).toHaveLength(3);
    expect(world.state.records.some((r) => r.event === 'started' && r.key === ALL_KEYS[3])).toBe(
      false
    );
    expect(world.state.records.at(-1)?.event).toBe('run-halted');
    expect(world.events.at(-1)?.type).toBe('run-halted');
  });

  it('does not retry a step once the approval is no longer recorded', async () => {
    const world = new World();
    const target = key('create-database');
    world.failAlways.add(target);
    world.afterCall = undefined;
    world.beforeCall = (request) => {
      if (request.key === target) world.approval = undefined;
    };
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(world.callCount(target)).toBe(1);
  });

  it('refuses a step whose part of the approval was withdrawn', async () => {
    const world = new World();
    world.afterCall = (count) => {
      if (count === 1) world.approval = { ...APPROVAL, scopes: ['setup'] };
    };
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalScopeError
    );
    expect(world.calls).toHaveLength(8);
  });

  it('runs nothing when the ledger answers with a different approval than the one asked for', async () => {
    const world = new World();
    world.approval = { ...APPROVAL, approvalId: 'OTHER_APPROVAL_PLACEHOLDER' };
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(world.calls).toEqual([]);
    expect(world.state.records.map((r) => r.event)).toEqual(['run-halted']);
  });

  it('stops mid-run when the ledger starts answering with a different approval', async () => {
    const world = new World();
    world.afterCall = (count) => {
      if (count === 2) world.approval = { ...APPROVAL, approvalId: 'OTHER_APPROVAL_PLACEHOLDER' };
    };
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(world.calls).toHaveLength(2);
  });

  it('refuses to continue under an approval that now names another tenant', async () => {
    const world = new World();
    world.afterCall = (count) => {
      if (count === 2) world.approval = { ...APPROVAL, tenantId: 'OTHER_ID_PLACEHOLDER' };
    };
    await expect(executeOnboarding(APPROVAL.approvalId, world.ports())).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(world.calls).toHaveLength(2);
  });
});

describe('executeOnboarding: a console that never answers', () => {
  it('stops waiting for a report after the timeout, so the run carries on and counts the loss', async () => {
    const world = new World();
    world.consoleHangs = true;
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports(), {
      reportTimeoutMs: 5,
    });
    expect(result.status).toBe('complete');
    expect(world.calls).toHaveLength(STEP_IDS.length);
    expect(result.reportFailures).toBeGreaterThan(STEP_IDS.length);
  }, 3000);

  it('does not widen the revocation window: the next gate check still runs while the console hangs', async () => {
    const world = new World();
    world.consoleHangs = true;
    world.afterCall = (count) => {
      if (count === 3) world.approval = undefined;
    };
    await expect(
      executeOnboarding(APPROVAL.approvalId, world.ports(), { reportTimeoutMs: 5 })
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(world.calls).toHaveLength(3);
  }, 3000);

  it('applies a default timeout when none is given', async () => {
    vi.useFakeTimers();
    try {
      const world = new World();
      world.consoleHangs = true;
      let finished = false;
      void executeOnboarding(APPROVAL.approvalId, world.ports()).then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(2000 * (STEP_IDS.length * 2 + 4));
      expect(finished).toBe(true);
      expect(world.calls).toHaveLength(STEP_IDS.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a report timeout of %s before touching anything',
    async (ms) => {
      const world = new World();
      const err = await executeOnboarding(APPROVAL.approvalId, world.ports(), {
        reportTimeoutMs: ms,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidRunOptionsError);
      expect((err as InvalidRunOptionsError).fields).toEqual(['reportTimeoutMs']);
      expect(world.calls).toEqual([]);
      expect(world.state.records).toEqual([]);
    }
  );
});

describe('executeOnboarding: the console', () => {
  it('does not let an unreachable console stop or corrupt a run, and counts what was lost', async () => {
    const world = new World();
    world.consoleFails = true;
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(result.status).toBe('complete');
    expect(result.reportFailures).toBeGreaterThan(STEP_IDS.length);
    expect(world.state.completeKeys()).toHaveLength(STEP_IDS.length);
  });
});
