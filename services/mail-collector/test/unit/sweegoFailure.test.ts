import { describe, expect, it } from 'vitest';
import {
  SweegoSubmissionError,
  classifySweegoError,
  failureReasonOf,
  type SweegoFailureReason,
} from '../../src/sweegoFailure.js';
import { TargetSubmissionError, type SubmissionFailureKind } from '../../src/sendingTarget.js';

function nodemailerError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('text a relay wrote, with reader@example.com in it'), fields);
}

describe('classifySweegoError', () => {
  // The shapes nodemailer gives for failures a local relay cannot be made to
  // produce on demand (DNS, resets, setup timeouts).
  const CASES: Array<
    [string, Record<string, unknown>, SweegoFailureReason, SubmissionFailureKind]
  > = [
    ['a DNS failure', { code: 'EDNS' }, 'unreachable', 'not-accepted'],
    [
      'a refused connection',
      { code: 'ESOCKET', originalCode: 'ECONNREFUSED' },
      'unreachable',
      'not-accepted',
    ],
    [
      'an unknown host',
      { code: 'ECONNECTION', originalCode: 'ENOTFOUND' },
      'unreachable',
      'not-accepted',
    ],
    [
      'a connect timeout',
      { code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT' },
      'unreachable',
      'not-accepted',
    ],
    [
      'a greeting that never came',
      { code: 'ETIMEDOUT', timeoutType: 'GREETING_TIMEOUT' },
      'unreachable',
      'not-accepted',
    ],
    ['a TLS failure', { code: 'ETLS', command: 'CONN' }, 'unreachable', 'not-accepted'],
    [
      'a server that ends the session at EHLO',
      { code: 'ECONNECTION', command: 'EHLO', responseCode: 554 },
      'unreachable',
      'not-accepted',
    ],
    [
      'a session timeout past setup',
      { code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT', command: 'CONN' },
      'timeout',
      'ambiguous',
    ],
    [
      'a reset that may have come after DATA',
      { code: 'ESOCKET', originalCode: 'ECONNRESET' },
      'ambiguous',
      'ambiguous',
    ],
    [
      'a connection closed mid-session',
      { code: 'ECONNECTION', command: 'CONN' },
      'ambiguous',
      'ambiguous',
    ],
    ['a refused login', { code: 'EAUTH', responseCode: 535 }, 'auth', 'not-accepted'],
    [
      'an envelope the client could not form',
      { code: 'EENVELOPE', command: 'API' },
      'recipient-rejected',
      'recipient-rejected',
    ],
    [
      'a 4xx reply to the DATA command',
      { code: 'EENVELOPE', command: 'DATA', responseCode: 451 },
      'deferred',
      'not-accepted',
    ],
    [
      'a 5xx reply to the DATA command',
      { code: 'EENVELOPE', command: 'DATA', responseCode: 554 },
      'refused',
      'not-accepted',
    ],
    [
      'an envelope refusal that names no step and no reply',
      { code: 'EENVELOPE' },
      'ambiguous',
      'ambiguous',
    ],
    ['a failed message', { code: 'EMESSAGE', responseCode: 554 }, 'ambiguous', 'ambiguous'],
    ['an error with no code', {}, 'ambiguous', 'ambiguous'],
  ];

  it.each(CASES)('classes %s', (_label, fields, reason, kind) => {
    const classified = classifySweegoError(nodemailerError(fields));
    expect(classified.reason).toBe(reason);
    expect(classified.kind).toBe(kind);
  });

  it('classes a value that is not an error as ambiguous', () => {
    expect(classifySweegoError('boom').reason).toBe('ambiguous');
    expect(classifySweegoError(undefined).reason).toBe('ambiguous');
  });

  it('keeps nothing of the underlying error in the one it throws', () => {
    const classified = classifySweegoError(
      nodemailerError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 })
    );
    expect(classified.message).toBe('sweego submission failed: recipient-rejected (550)');
    expect(classified.cause).toBeUndefined();
  });
});

describe('failureReasonOf', () => {
  it('reads a Sweego failure as its reason and anything else as unclassified', () => {
    expect(failureReasonOf(new SweegoSubmissionError('deferred', 451))).toBe('deferred');
    expect(failureReasonOf(new TargetSubmissionError('x', 'not-accepted'))).toBe('unclassified');
    expect(failureReasonOf(new Error('x'))).toBe('unclassified');
  });
});
