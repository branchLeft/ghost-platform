import { TargetSubmissionError, type SubmissionFailureKind } from './sendingTarget.js';

/**
 * Why a Sweego submission failed, as the signals that count failures will
 * label them. Labels only: no address, subject, credential or server text is
 * ever part of a reason. See ../README.md#sweegofailure-classifysweegoerror.
 */
export type SweegoFailureReason =
  /** Connection refused, DNS failure, TLS or greeting failure, connect timeout. Nothing was taken. */
  | 'unreachable'
  /** The relay refused the login. Nothing was taken. */
  | 'auth'
  /** The credential file could not be read, or was empty. Nothing was taken. */
  | 'credential'
  /** A 4xx at MAIL, RCPT or the DATA command. Nothing was taken. */
  | 'deferred'
  /** A 5xx at MAIL or the DATA command: the relay refused the sender or the transaction. Nothing was taken. */
  | 'refused'
  /** A 5xx at RCPT, or an envelope the client could not form: a bad address is bad everywhere. The only terminal reason. */
  | 'recipient-rejected'
  /** A timeout once the session was past setup: the relay may have the message. */
  | 'timeout'
  /** A failure at or after DATA, or any failure that could not be placed: the relay may have the message. */
  | 'ambiguous';

/** A failure that no Sweego client classified (a test double, or a bug): counted, never trusted. */
export type CountedFailureReason = SweegoFailureReason | 'unclassified';

const KIND_OF_REASON: Readonly<Record<SweegoFailureReason, SubmissionFailureKind>> = {
  unreachable: 'not-accepted',
  auth: 'not-accepted',
  credential: 'not-accepted',
  deferred: 'not-accepted',
  refused: 'not-accepted',
  'recipient-rejected': 'recipient-rejected',
  timeout: 'ambiguous',
  ambiguous: 'ambiguous',
};

/**
 * What the Sweego client throws. The message is built here from the reason and
 * the SMTP reply number alone, never from the relay's own text (which can echo
 * an address) and never from the underlying error, so it is safe to log.
 */
export class SweegoSubmissionError extends TargetSubmissionError {
  constructor(
    readonly reason: SweegoFailureReason,
    readonly smtpCode?: number
  ) {
    super(
      `sweego submission failed: ${reason}${smtpCode === undefined ? '' : ` (${smtpCode})`}`,
      KIND_OF_REASON[reason]
    );
    this.name = 'SweegoSubmissionError';
  }
}

/** The label a failure is counted under. */
export function failureReasonOf(error: unknown): CountedFailureReason {
  return error instanceof SweegoSubmissionError ? error.reason : 'unclassified';
}

// Only a connection attempt can fail with these, so nothing was sent.
const CONNECT_ONLY_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
]);
// Timeouts of the setup phases, before any mail command.
const SETUP_TIMEOUTS = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);
const SETUP_COMMANDS = new Set(['EHLO', 'HELO', 'LHLO', 'STARTTLS']);

interface NodemailerErrorShape {
  code?: unknown;
  originalCode?: unknown;
  command?: unknown;
  responseCode?: unknown;
  timeoutType?: unknown;
}

function field(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Names how a nodemailer error maps onto the design's outcomes. Conservative
 * by construction: anything that may have reached the relay's queue, and
 * anything unplaced, is `ambiguous` or `timeout`, which never falls back to
 * mx1 and so cannot duplicate a message. Only a definite non-acceptance is
 * `not-accepted`.
 */
export function classifySweegoError(error: unknown): SweegoSubmissionError {
  const shape: NodemailerErrorShape = typeof error === 'object' && error !== null ? error : {};
  const code = field(shape.code);
  const command = field(shape.command);
  const smtpCode =
    typeof shape.responseCode === 'number' && Number.isInteger(shape.responseCode)
      ? shape.responseCode
      : undefined;
  const permanent = smtpCode !== undefined && smtpCode >= 500;

  switch (code) {
    case 'EAUTH':
      return new SweegoSubmissionError('auth', smtpCode);
    case 'EDNS':
      return new SweegoSubmissionError('unreachable');
    case 'ECONNECTION':
    case 'ESOCKET': {
      const original = field(shape.originalCode);
      const setup =
        (original !== undefined && CONNECT_ONLY_CODES.has(original)) ||
        (command !== undefined && SETUP_COMMANDS.has(command));
      return new SweegoSubmissionError(setup ? 'unreachable' : 'ambiguous', smtpCode);
    }
    case 'ETLS':
      return new SweegoSubmissionError('unreachable');
    case 'ETIMEDOUT': {
      const type = field(shape.timeoutType);
      return new SweegoSubmissionError(
        type !== undefined && SETUP_TIMEOUTS.has(type) ? 'unreachable' : 'timeout'
      );
    }
    case 'EENVELOPE':
      // An envelope the client refused to form (no recipient, a malformed
      // address). The only case with no reply to read, and the only one besides
      // a 5xx at RCPT that is a bad address.
      if (command === 'API') {
        return new SweegoSubmissionError('recipient-rejected');
      }
      if (smtpCode === undefined) {
        return new SweegoSubmissionError('ambiguous');
      }
      if (command === 'RCPT TO' && permanent) {
        return new SweegoSubmissionError('recipient-rejected', smtpCode);
      }
      // A refusal at MAIL, RCPT (4xx) or the DATA command comes before any
      // content is sent, so nothing was taken and the address is not at fault.
      return new SweegoSubmissionError(permanent ? 'refused' : 'deferred', smtpCode);
    default:
      return new SweegoSubmissionError('ambiguous', smtpCode);
  }
}
