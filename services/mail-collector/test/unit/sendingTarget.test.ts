import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DescriptorTargetStore } from '../../src/descriptorTargets.js';
import { createLogger } from '../../src/log.js';
import {
  FALLBACK_EDGES,
  QUOTA_UNKNOWN,
  SweegoAfterMx1Error,
  TargetSubmissionError,
  assertNoSweegoAfterMx1,
  failureKindOf,
  mailClassOf,
  resolveSendingTarget,
  type MailClass,
  type SendingContext,
  type SubmissionFailureKind,
} from '../../src/sendingTarget.js';

const CLASSES: MailClass[] = ['transactional', 'bulk'];
const FAILURES: SubmissionFailureKind[] = ['not-accepted', 'recipient-rejected', 'ambiguous'];

/** A Sweego tenant with Sweego configured and nothing reached: the one context in which Sweego is chosen. */
function healthy(overrides: Partial<SendingContext> = {}): SendingContext {
  return {
    mailClass: 'transactional',
    demo: false,
    sweegoConfigured: true,
    allowanceReached: false,
    accountCapReached: false,
    reachedMx1: false,
    ...overrides,
  };
}

describe('mail class comes from the wire emailId', () => {
  it('is transactional for a null emailId and bulk for any other', () => {
    expect(mailClassOf(null)).toBe('transactional');
    expect(mailClassOf('email-1')).toBe('bulk');
    expect(mailClassOf('')).toBe('bulk');
  });
});

describe('hard rule: a mx1 route is mx1, always', () => {
  it.each(CLASSES)('is mx1 for %s mail whatever the context', (mailClass) => {
    for (const sweegoConfigured of [true, false]) {
      for (const allowanceReached of [true, false]) {
        for (const accountCapReached of [true, false]) {
          for (const reachedMx1 of [true, false]) {
            for (const demo of [true, false]) {
              expect(
                resolveSendingTarget('mx1', {
                  mailClass,
                  demo,
                  sweegoConfigured,
                  allowanceReached,
                  accountCapReached,
                  reachedMx1,
                })
              ).toBe('mx1');
            }
          }
        }
      }
    }
  });

  it('is mx1 for a route value the type does not name (the conservative reading)', () => {
    expect(resolveSendingTarget('SWEEGO' as never, healthy())).toBe('mx1');
    expect(resolveSendingTarget(undefined as never, healthy())).toBe('mx1');
  });
});

describe('a sweego route is sweego only when every condition for it holds', () => {
  it.each(CLASSES)(
    'sends %s mail to sweego when configured, within allowance and cap',
    (mailClass) => {
      expect(resolveSendingTarget('sweego', healthy({ mailClass }))).toBe('sweego');
    }
  );
});

describe('hard rule: with no Sweego delivery client the route is served by mx1', () => {
  it.each(CLASSES)('is mx1 for %s mail', (mailClass) => {
    expect(resolveSendingTarget('sweego', healthy({ mailClass, sweegoConfigured: false }))).toBe(
      'mx1'
    );
  });
});

describe('hard rule: a latched allowance or a reached account cap sends everything to mx1', () => {
  it.each(CLASSES)('is mx1 for %s mail once the tenant allowance is reached', (mailClass) => {
    expect(resolveSendingTarget('sweego', healthy({ mailClass, allowanceReached: true }))).toBe(
      'mx1'
    );
  });

  it.each(CLASSES)('is mx1 for %s mail once the account cap is reached', (mailClass) => {
    expect(resolveSendingTarget('sweego', healthy({ mailClass, accountCapReached: true }))).toBe(
      'mx1'
    );
  });

  it('reads an unknown quota as reached, so nothing goes to sweego without a counter', () => {
    expect(QUOTA_UNKNOWN.allowanceReached('any')).toBe(true);
    expect(QUOTA_UNKNOWN.accountCapReached()).toBe(true);
  });
});

describe('hard rule: a demo never goes to sweego', () => {
  it.each(CLASSES)('is mx1 for %s mail from a demo even on a sweego route', (mailClass) => {
    expect(resolveSendingTarget('sweego', healthy({ mailClass, demo: true }))).toBe('mx1');
  });

  it('is never sweego for a demo, over every class and failure', () => {
    for (const mailClass of CLASSES) {
      for (const failed of [
        undefined,
        ...FAILURES.map((kind) => ({ target: 'sweego' as const, kind })),
      ]) {
        expect(resolveSendingTarget('sweego', healthy({ mailClass, demo: true, failed }))).not.toBe(
          'sweego'
        );
      }
    }
  });
});

describe('hard rule: login mail falls back to mx1 only on a definite non-acceptance', () => {
  it('goes to mx1 after a sweego connection, DNS, auth or 4xx refusal', () => {
    expect(
      resolveSendingTarget(
        'sweego',
        healthy({ mailClass: 'transactional', failed: { target: 'sweego', kind: 'not-accepted' } })
      )
    ).toBe('mx1');
  });

  it('is held, not sent to mx1, after a recipient rejection (a bad address is bad everywhere)', () => {
    expect(
      resolveSendingTarget(
        'sweego',
        healthy({
          mailClass: 'transactional',
          failed: { target: 'sweego', kind: 'recipient-rejected' },
        })
      )
    ).toBe('hold');
  });

  it('is held, not sent to mx1, after an ambiguous failure (a timeout after DATA may have been accepted)', () => {
    expect(
      resolveSendingTarget(
        'sweego',
        healthy({ mailClass: 'transactional', failed: { target: 'sweego', kind: 'ambiguous' } })
      )
    ).toBe('hold');
  });

  it('treats an error that names no kind as ambiguous', () => {
    expect(failureKindOf(new Error('boom'))).toBe('ambiguous');
    expect(failureKindOf('boom')).toBe('ambiguous');
    expect(failureKindOf(new TargetSubmissionError('refused', 'not-accepted'))).toBe(
      'not-accepted'
    );
  });
});

describe('hard rule: bulk waits and retries sweego, it never falls back after a failure', () => {
  it.each(FAILURES)('is held after a %s failure', (kind) => {
    expect(
      resolveSendingTarget(
        'sweego',
        healthy({ mailClass: 'bulk', failed: { target: 'sweego', kind } })
      )
    ).toBe('hold');
  });

  it('is offered to sweego again on the next offer', () => {
    expect(resolveSendingTarget('sweego', healthy({ mailClass: 'bulk' }))).toBe('sweego');
  });
});

describe('hard rule: once a message reached mx1 it is mx1 for good (once per message)', () => {
  it.each(CLASSES)('is mx1 for %s mail already pinned, on a sweego route', (mailClass) => {
    expect(resolveSendingTarget('sweego', healthy({ mailClass, reachedMx1: true }))).toBe('mx1');
  });

  it('is mx1 for a pinned message even if sweego has since recovered and failed nothing', () => {
    expect(resolveSendingTarget('sweego', healthy({ reachedMx1: true, failed: undefined }))).toBe(
      'mx1'
    );
  });
});

describe('hard rule: never mx1 to sweego, for any mail type or failure', () => {
  it('has exactly one fallback edge, sweego to mx1, and none out of mx1', () => {
    expect(FALLBACK_EDGES).toEqual({ sweego: ['mx1'], mx1: [] });
  });

  it('never returns sweego after a failed mx1 attempt, over every route, class, failure and context', () => {
    let checked = 0;
    for (const route of ['mx1', 'sweego'] as const) {
      for (const mailClass of CLASSES) {
        for (const kind of FAILURES) {
          for (const sweegoConfigured of [true, false]) {
            for (const allowanceReached of [true, false]) {
              for (const accountCapReached of [true, false]) {
                for (const reachedMx1 of [true, false]) {
                  const decision = resolveSendingTarget(
                    route,
                    healthy({
                      mailClass,
                      sweegoConfigured,
                      allowanceReached,
                      accountCapReached,
                      reachedMx1,
                      failed: { target: 'mx1', kind },
                    })
                  );
                  expect(decision).not.toBe('sweego');
                  checked += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * 2 * 3 * 2 * 2 * 2 * 2);
  });

  it('never returns sweego for any message that reached mx1, over every route, class and failure', () => {
    for (const route of ['mx1', 'sweego'] as const) {
      for (const mailClass of CLASSES) {
        for (const failed of [
          undefined,
          ...FAILURES.map((kind) => ({ target: 'sweego' as const, kind })),
        ]) {
          expect(
            resolveSendingTarget(route, healthy({ mailClass, reachedMx1: true, failed }))
          ).not.toBe('sweego');
        }
      }
    }
  });

  it('refuses outright if a decision ever puts sweego after mx1 (the last guard)', () => {
    expect(() => assertNoSweegoAfterMx1(true, 'sweego')).toThrow(SweegoAfterMx1Error);
    expect(() => assertNoSweegoAfterMx1(true, 'mx1')).not.toThrow();
    expect(() => assertNoSweegoAfterMx1(true, 'hold')).not.toThrow();
    expect(() => assertNoSweegoAfterMx1(false, 'sweego')).not.toThrow();
  });
});

describe('hard rule: the route configuration cannot express a fallback, exception or per-type key', () => {
  let dir: string;
  const warnings: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-sending-'));
    warnings.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['a fallback to sweego beside mx1', { primary: 'mx1', fallback: 'sweego' }],
    ['a login-mail fallback beside mx1', { primary: 'mx1', loginFallback: 'sweego' }],
    ['an exception list', { primary: 'mx1', except: ['transactional'] }],
    ['an allow-list', { primary: 'mx1', allow: ['mx1-to-sweego'] }],
    ['a per-type key', { primary: 'mx1', transactional: 'sweego' }],
    ['a mx1-to-sweego route name', { primary: 'mx1-to-sweego' }],
  ])('makes a route with %s malformed: the host is not drained', async (_label, route) => {
    writeFileSync(
      join(dir, 'tenant-a.json'),
      JSON.stringify({
        kind: 'tenant',
        slug: 'tenant-a',
        appHostIp: '127.0.0.1',
        expiresAt: null,
        mail: { route },
      })
    );
    const store = new DescriptorTargetStore({
      descriptorDir: dir,
      shimScheme: 'http',
      shimPort: 8080,
      maxStalenessMs: 60_000,
      log: createLogger((line) => warnings.push(line)),
    });
    await store.refresh();
    expect(store.targets).toEqual([]);
    expect(warnings.join('\n')).toContain('descriptor_malformed');
  });

  it('marks a demo target as a demo, and a tenant target as no demo', async () => {
    for (const kind of ['demo', 'tenant'] as const) {
      writeFileSync(
        join(dir, `${kind}.json`),
        JSON.stringify({ kind, slug: kind, appHostIp: '127.0.0.1', expiresAt: null })
      );
    }
    const store = new DescriptorTargetStore({
      descriptorDir: dir,
      shimScheme: 'http',
      shimPort: 8080,
      maxStalenessMs: 60_000,
      log: createLogger((line) => warnings.push(line)),
    });
    await store.refresh();
    const byId = Object.fromEntries(store.targets.map((t) => [t.id, t.demo]));
    expect(byId).toEqual({ demo: true, tenant: undefined });
  });
});
