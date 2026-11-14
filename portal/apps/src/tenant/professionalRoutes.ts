import type { TenantScope } from 'ghost-platform-portal-data/tenant';
import { PromotionError } from './promotionError.js';
import {
  PROFESSIONAL_LIMITED_PATH,
  PROFESSIONAL_PATH,
  PROFESSIONAL_SEND_PATH,
  PROFESSIONAL_SENT_PATH,
  renderNotForThisTenant,
  renderProfessionalForm,
  renderProfessionalLimited,
  renderProfessionalSent,
} from './promotionPages.js';
import {
  NO_ROUTES,
  readKind,
  type KindReader,
  type PromotionAction,
  type PromotionPage,
  type RouteSet,
} from './essentialsRoutes.js';
import { MESSAGE_DELIMITER } from './supportContext.js';
import { SupportLimiter } from './supportLimiter.js';
import type { SupportMailer, SupportMessage, SupportSettings } from './supportMailer.js';
import { SupportTicketError } from './supportTicketError.js';
import { assertHeaderValue, validateContact, validateMessage } from './supportValidation.js';

/** The fixed part of every enquiry's subject; the tenant identifier follows. */
export const ENQUIRY_SUBJECT_PREFIX = 'PROFESSIONAL_ENQUIRY';

/** The screen line in the body, so a reader can tell an enquiry from a support ticket at a glance. */
export const ENQUIRY_SCREEN = 'PROFESSIONAL';

export interface EnquirySubmitterOptions {
  readonly reader: KindReader;
  readonly mailer: SupportMailer;
  readonly recipient: string;
  readonly sender: string;
  readonly limiter: SupportLimiter;
}

/**
 * Turns one posted form into one email, through the support mail path: the
 * same mailer port, the same validation and the same kind of limiter. Only
 * `contact` and `message` are read from the form. The tenant identifier is the
 * session's scope and the tenant's name is never asked for or sent.
 */
export class EnquirySubmitter {
  readonly #options: EnquirySubmitterOptions;

  /** @throws {SupportTicketError} INVALID_HEADER_VALUE when the recipient or sender is unusable. */
  constructor(options: EnquirySubmitterOptions) {
    assertHeaderValue(options.recipient);
    assertHeaderValue(options.sender);
    this.#options = options;
  }

  /**
   * Returns the path to redirect to: the sent page, or the limited page when
   * the tenant is over its limit.
   *
   * @throws {PromotionError} NOT_A_DEMO or READ_FAILED.
   * @throws {SupportTicketError} INVALID_CONTACT, EMPTY_MESSAGE, MESSAGE_TOO_LONG,
   *   INVALID_MESSAGE, INVALID_HEADER_VALUE or SEND_FAILED.
   */
  async submit(scope: TenantScope, form: URLSearchParams): Promise<string> {
    const contact = validateContact(form.get('contact') ?? '');
    const message = validateMessage(form.get('message') ?? '');
    if ((await readKind(this.#options.reader, scope)) !== 'DEMO') {
      throw new PromotionError('NOT_A_DEMO');
    }
    if (!this.#options.limiter.tryTake(scope.tenantId)) return PROFESSIONAL_LIMITED_PATH;
    await this.#deliver({
      to: this.#options.recipient,
      from: this.#options.sender,
      replyTo: contact,
      subject: `${ENQUIRY_SUBJECT_PREFIX} ${scope.tenantId}`,
      body: `TENANT_ID: ${scope.tenantId}\nSCREEN: ${ENQUIRY_SCREEN}\n\n${MESSAGE_DELIMITER}\n${message}`,
    });
    return PROFESSIONAL_SENT_PATH;
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

/**
 * The Professional enquiry: a form and one email. It does not call the
 * provisioning API, and nothing is recorded: the email is the enquiry. With no
 * mail settings the screens do not exist, as for support.
 */
export function createProfessionalRoutes(
  settings: SupportSettings | undefined,
  reader: KindReader,
  clock: () => number
): RouteSet {
  if (settings === undefined) return NO_ROUTES;
  const submitter = new EnquirySubmitter({
    reader,
    mailer: settings.mailer,
    recipient: settings.recipient,
    sender: settings.sender,
    limiter: new SupportLimiter(clock),
  });
  const pages: Record<string, PromotionPage> = {
    [PROFESSIONAL_PATH]: async (scope) =>
      (await readKind(reader, scope)) === 'DEMO'
        ? renderProfessionalForm()
        : renderNotForThisTenant(),
    [PROFESSIONAL_SENT_PATH]: async () => renderProfessionalSent(),
    [PROFESSIONAL_LIMITED_PATH]: async () => renderProfessionalLimited(),
  };
  const actions: Record<string, PromotionAction> = {
    [PROFESSIONAL_SEND_PATH]: (scope, _identity, form) => submitter.submit(scope, form),
  };
  return { nav: [{ label: 'NAV_PROFESSIONAL', href: PROFESSIONAL_PATH }], pages, actions };
}
