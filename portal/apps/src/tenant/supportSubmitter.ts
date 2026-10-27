import type { HealthView, TenantScope } from 'ghost-platform-portal-data/tenant';
import { buildContextLines, renderTicketBody } from './supportContext.js';
import type { SupportLimiter } from './supportLimiter.js';
import type { SupportMailer, SupportMessage } from './supportMailer.js';
import type { RecordedScreen } from './supportScreens.js';
import { SupportTicketError } from './supportTicketError.js';
import { assertHeaderValue, validateContact, validateMessage } from './supportValidation.js';

/** Where a sent ticket lands. Fixed: nothing from the request names it. */
export const SENT_PATH = '/support/sent';

/** Where a ticket over the limit lands. */
export const LIMITED_PATH = '/support/limited';

/** The fixed part of every ticket's subject; the tenant identifier follows. */
export const SUBJECT_PREFIX = 'SUPPORT_TICKET';

/** The two reads a ticket needs, both bound to the session's scope. `TenantDb` satisfies it. */
export interface SupportReader {
  ownRegistration(scope: TenantScope): Promise<{ readonly tenantId: string } | null>;
  ownHealth(scope: TenantScope): Promise<HealthView | null>;
}

export interface TicketSubmitterOptions {
  readonly reader: SupportReader;
  readonly mailer: SupportMailer;
  readonly recipient: string;
  readonly sender: string;
  readonly limiter: SupportLimiter;
}

/**
 * Turns one posted form into one email. Only the `contact` and `message`
 * fields are read. The tenant identifier, the health and the version come from
 * fresh reads bound to the session's scope, and the screen from the caller:
 * nothing else in the request reaches the email.
 */
export class TicketSubmitter {
  readonly #options: TicketSubmitterOptions;

  /** @throws {SupportTicketError} INVALID_HEADER_VALUE when the recipient or sender is unusable. */
  constructor(options: TicketSubmitterOptions) {
    assertHeaderValue(options.recipient);
    assertHeaderValue(options.sender);
    this.#options = options;
  }

  /**
   * Returns the path to redirect to: the sent page, or the limited page when
   * the tenant is over its limit.
   *
   * @throws {SupportTicketError} INVALID_CONTACT, EMPTY_MESSAGE, MESSAGE_TOO_LONG,
   *   INVALID_MESSAGE, TENANT_NOT_REGISTERED, INVALID_HEADER_VALUE or SEND_FAILED.
   */
  async submit(screen: RecordedScreen, scope: TenantScope, form: URLSearchParams): Promise<string> {
    const contact = validateContact(form.get('contact') ?? '');
    const message = validateMessage(form.get('message') ?? '');
    if (!this.#options.limiter.tryTake(scope.tenantId)) return LIMITED_PATH;
    const registration = await this.#options.reader.ownRegistration(scope);
    if (registration === null) throw new SupportTicketError('TENANT_NOT_REGISTERED');
    const health = await this.#options.reader.ownHealth(scope);
    const context = buildContextLines({ tenantId: registration.tenantId, health, screen });
    await this.#deliver({
      to: this.#options.recipient,
      from: this.#options.sender,
      replyTo: contact,
      subject: `${SUBJECT_PREFIX} ${registration.tenantId}`,
      body: renderTicketBody(context, message),
    });
    return SENT_PATH;
  }

  async #deliver(message: SupportMessage): Promise<void> {
    for (const header of [message.to, message.from, message.replyTo, message.subject]) {
      assertHeaderValue(header);
    }
    try {
      await this.#options.mailer.send(message);
    } catch (error) {
      throw new SupportTicketError(
        'SEND_FAILED',
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }
}
