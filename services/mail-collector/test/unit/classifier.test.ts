import { describe, expect, it } from 'vitest';
import { laneOf } from '../../src/lanes.js';
import { mailClassOf, type MailClass } from '../../src/sendingTarget.js';
import type { Lane } from '../../src/lanes.js';

/**
 * The resolver reads `mailClassOf`, the throttle and the loop's lane order read
 * `laneOf`. They must never disagree about one message, so each case is asked
 * of both and pinned. An id that is not a non-empty string names no campaign:
 * the mailgun shim writes no X-Ghost-Email-Id header for it (it tests the
 * row's emailId for truthiness), so it is sign-in mail on both sides.
 */
const CASES: ReadonlyArray<{
  name: string;
  emailId: string | null | undefined;
  mailClass: MailClass;
  lane: Lane;
}> = [
  { name: 'null', emailId: null, mailClass: 'transactional', lane: 'login' },
  { name: 'missing (undefined)', emailId: undefined, mailClass: 'transactional', lane: 'login' },
  { name: 'empty string', emailId: '', mailClass: 'transactional', lane: 'login' },
  {
    name: 'a Ghost email id',
    emailId: '5f8d0d55b54764421b7156c1',
    mailClass: 'bulk',
    lane: 'bulk',
  },
  { name: 'any other non-empty id', emailId: 'campaign-1', mailClass: 'bulk', lane: 'bulk' },
];

describe('one classifier decides login or bulk for the resolver and the lane', () => {
  it.each(CASES)('$name: class and lane agree and are pinned', (c) => {
    expect(mailClassOf(c.emailId)).toBe(c.mailClass);
    expect(laneOf({ emailId: c.emailId })).toBe(c.lane);
  });

  it.each(CASES)('$name: the lane is login exactly when the class is transactional', (c) => {
    const loginLane = laneOf({ emailId: c.emailId }) === 'login';
    expect(loginLane).toBe(mailClassOf(c.emailId) === 'transactional');
  });

  it('never throttles sign-in mail as bulk: an empty id is not bulk on either side', () => {
    expect(mailClassOf('')).not.toBe('bulk');
    expect(laneOf({ emailId: '' })).not.toBe('bulk');
  });
});
