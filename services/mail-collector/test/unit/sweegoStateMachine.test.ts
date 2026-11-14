import { describe, expect, it } from 'vitest';
import {
  isPermanentBounce,
  reportKindFor,
  step,
  toReport,
  type MessageState,
  type Observation,
} from '../../src/sweegoOutcomes/stateMachine.js';

const hard = (code: number | null = 550): Observation => ({
  kind: 'undelivered',
  bounce: 'hard',
  code,
  message: 'MSG',
});
const soft: Observation = { kind: 'undelivered', bounce: 'soft', code: 452, message: 'MSG' };

describe('step', () => {
  it('moves a submitted message to deferred only when the provider says it was deferred', () => {
    expect(step('submitted', { kind: 'queued', deferred: true })).toBe('deferred');
    expect(step('submitted', { kind: 'queued', deferred: false })).toBe('submitted');
  });

  it.each(['submitted', 'deferred', 'bounced-soft', 'expired'] as MessageState[])(
    'delivers from %s',
    (from) => {
      expect(step(from, { kind: 'delivered' })).toBe('delivered');
    }
  );

  it('never moves delivered back to an earlier state', () => {
    expect(step('delivered', { kind: 'queued', deferred: true })).toBe('delivered');
    expect(step('delivered', soft)).toBe('delivered');
    expect(step('delivered', { kind: 'timeout' })).toBe('delivered');
  });

  it('a hard bounce is final, including after delivered, and is never overwritten', () => {
    expect(step('submitted', hard())).toBe('bounced-hard');
    expect(step('delivered', hard())).toBe('bounced-hard');
    expect(step('bounced-hard', { kind: 'delivered' })).toBe('bounced-hard');
    expect(step('bounced-hard', soft)).toBe('bounced-hard');
  });

  it('a soft bounce is not final: a later delivery or hard bounce replaces it', () => {
    expect(step('submitted', soft)).toBe('bounced-soft');
    expect(step('bounced-soft', { kind: 'delivered' })).toBe('delivered');
    expect(step('bounced-soft', hard())).toBe('bounced-hard');
  });

  it('a complaint lands on delivered and expired messages but never replaces a hard bounce', () => {
    expect(step('delivered', { kind: 'complaint' })).toBe('complained');
    expect(step('expired', { kind: 'complaint' })).toBe('complained');
    expect(step('bounced-hard', { kind: 'complaint' })).toBe('bounced-hard');
  });

  it('a timeout closes only messages that are still open', () => {
    expect(step('submitted', { kind: 'timeout' })).toBe('expired');
    expect(step('deferred', { kind: 'timeout' })).toBe('expired');
    expect(step('bounced-soft', { kind: 'timeout' })).toBe('expired');
    expect(step('complained', { kind: 'timeout' })).toBe('complained');
  });

  it('an unclassified undelivered record changes nothing', () => {
    const vague: Observation = { kind: 'undelivered', bounce: null, code: null, message: null };
    expect(step('submitted', vague)).toBe('submitted');
  });
});

describe('permanent bounce rule', () => {
  it('needs an explicit hard bounce and a 5xx code when a code is given', () => {
    expect(isPermanentBounce({ bounce: 'hard', code: 550 })).toBe(true);
    expect(isPermanentBounce({ bounce: 'hard', code: null })).toBe(true);
    expect(isPermanentBounce({ bounce: 'hard', code: 452 })).toBe(false);
    expect(isPermanentBounce({ bounce: 'soft', code: 550 })).toBe(false);
    expect(isPermanentBounce({ bounce: null, code: 550 })).toBe(false);
  });

  it('a hard bounce carrying a 4xx code is treated as soft and cannot suppress an address', () => {
    expect(step('submitted', hard(452))).toBe('bounced-soft');
  });
});

describe('reports', () => {
  const key = { id: 'ID', drainCount: 2 };
  it('owes nothing from open states or expired', () => {
    for (const state of ['submitted', 'deferred', 'expired'] as MessageState[]) {
      expect(reportKindFor(state)).toBeNull();
      expect(toReport(key, state, { code: null, message: null })).toBeNull();
    }
  });

  it('uses the existing delivered and failed shapes, and complained for a complaint', () => {
    const detail = { code: 550, message: 'MSG' };
    expect(toReport(key, 'delivered', detail)).toEqual({
      id: 'ID',
      drainCount: 2,
      outcome: 'delivered',
    });
    expect(toReport(key, 'bounced-hard', detail)).toEqual({
      id: 'ID',
      drainCount: 2,
      outcome: 'failed',
      severity: 'permanent',
      code: 550,
      message: 'MSG',
    });
    expect(toReport(key, 'bounced-soft', detail)).toMatchObject({ severity: 'temporary' });
    expect(toReport(key, 'complained', detail)).toEqual({
      id: 'ID',
      drainCount: 2,
      outcome: 'complained',
    });
  });
});
