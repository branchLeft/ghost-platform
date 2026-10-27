/** Why a support ticket was not sent. The messages are fixed and never carry what was posted. */
export type SupportTicketRefusal =
  | 'INVALID_CONTACT'
  | 'EMPTY_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'INVALID_MESSAGE'
  | 'INVALID_HEADER_VALUE'
  | 'TENANT_NOT_REGISTERED'
  | 'SEND_FAILED';

const MESSAGES: Readonly<Record<SupportTicketRefusal, string>> = {
  INVALID_CONTACT: 'the contact address is not a single plausible address',
  EMPTY_MESSAGE: 'the message is empty',
  MESSAGE_TOO_LONG: 'the message is longer than the limit',
  INVALID_MESSAGE: 'the message contains a character that is not allowed',
  INVALID_HEADER_VALUE: 'a mail header value is empty or contains a line break or NUL',
  TENANT_NOT_REGISTERED: 'the signed-in tenant has no register row',
  SEND_FAILED: 'the mailer did not send the ticket',
};

export class SupportTicketError extends Error {
  readonly reason: SupportTicketRefusal;

  /** `cause` is kept for a caller that wants it; the shell reports the error name only. */
  constructor(reason: SupportTicketRefusal, options?: { readonly cause: Error }) {
    super(MESSAGES[reason], options);
    this.name = 'SupportTicketError';
    this.reason = reason;
  }
}
