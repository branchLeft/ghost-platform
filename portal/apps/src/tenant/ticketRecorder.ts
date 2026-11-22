import {
  createTicket,
  type TicketKind,
} from 'ghost-platform-provisioning-controller/provisioning-api';
import { portalErrorLine } from '../shell/errorLine.js';
import { PROVISIONING_TIMEOUT_MS } from './promotionRequest.js';
import type { ProvisioningSettings } from './provisioningSettings.js';

/** What the portal records itself: an Essentials request is recorded by the provisioning API with its promotion request. */
export type RecordedKind = Extract<TicketKind, 'support' | 'professional-enquiry'>;

/** What the tenant wrote, already validated. */
export interface TicketText {
  readonly contact: string;
  readonly message: string;
}

/**
 * Why a ticket was not recorded. The messages are fixed and carry neither what
 * the tenant wrote nor what the provisioning API answered.
 */
export type TicketRecordRefusal =
  /** No credential was issued for this tenant, so the API is not asked. */
  | 'NO_CREDENTIAL'
  /** The API refused the portal's credential (401, 403) or the request itself (400). */
  | 'REFUSED'
  /** The tenant already holds the most tickets the API allows (409). */
  | 'LIMIT'
  /** The API did not answer in time, or at all, or answered with a server error. */
  | 'UNREACHABLE'
  /** The API answered with something the contract does not allow for this call. */
  | 'UNEXPECTED_ANSWER';

const MESSAGES: Readonly<Record<TicketRecordRefusal, string>> = {
  NO_CREDENTIAL: 'no provisioning credential was issued for the tenant',
  REFUSED: 'the provisioning API refused the ticket',
  LIMIT: 'the tenant holds the most open tickets the provisioning API allows',
  UNREACHABLE: 'the provisioning API could not be reached',
  UNEXPECTED_ANSWER: 'the provisioning API answered with something the contract does not allow',
};

export class TicketRecordError extends Error {
  readonly reason: TicketRecordRefusal;

  /** `cause` is kept for a caller that wants it; the log line carries the error name only. */
  constructor(reason: TicketRecordRefusal, options?: { readonly cause: Error }) {
    super(MESSAGES[reason], options);
    this.name = 'TicketRecordError';
    this.reason = reason;
  }
}

/**
 * Holds one contact request the tenant raised, for the owner to see. It never
 * throws: the mail has gone by the time it is called and stays the delivery, so
 * a ticket that could not be recorded is a logged line and not a failed request.
 */
export interface TicketRecorder {
  record(tenantId: string, kind: RecordedKind, text: TicketText): Promise<void>;
}

/** The recorder when there is no provisioning API: nothing is held. */
export const NO_RECORDER: TicketRecorder = { record: () => Promise.resolve() };

/**
 * Asks the provisioning API, through the generated client, to record one ticket
 * for `tenantId`, presenting the credential issued for that tenant.
 *
 * @throws {TicketRecordError} NO_CREDENTIAL, REFUSED, LIMIT, UNREACHABLE or UNEXPECTED_ANSWER.
 */
export async function recordTicket(
  settings: ProvisioningSettings,
  tenantId: string,
  kind: RecordedKind,
  text: TicketText
): Promise<void> {
  const credential = settings.credentialFor(tenantId);
  if (credential === undefined) throw new TicketRecordError('NO_CREDENTIAL');
  let result: Awaited<ReturnType<typeof createTicket>>;
  try {
    result = await createTicket({
      baseUrl: settings.baseUrl,
      auth: () => credential,
      throwOnError: false,
      redirect: 'error',
      signal: AbortSignal.timeout(PROVISIONING_TIMEOUT_MS),
      ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
      path: { tenant: tenantId },
      body: { kind, contact: text.contact, message: text.message },
    });
  } catch (error) {
    throw new TicketRecordError(
      'UNREACHABLE',
      error instanceof Error ? { cause: error } : undefined
    );
  }
  // No response at all is the client's own failure: a network error or a request it could not build.
  const status = result.response?.status;
  if (status === undefined) throw new TicketRecordError('UNREACHABLE');
  if (status === 201) {
    const held = result.data;
    // The answer is a new ticket for this tenant and this kind, or it is not an answer to this call.
    const ours =
      held !== undefined &&
      held.tenant_id === tenantId &&
      held.kind === kind &&
      held.state === 'new';
    if (!ours) throw new TicketRecordError('UNEXPECTED_ANSWER');
    return;
  }
  if (status === 409) {
    const code = (result.error as { code?: unknown } | undefined)?.code;
    throw new TicketRecordError(code === 'ticket-limit' ? 'LIMIT' : 'UNEXPECTED_ANSWER');
  }
  if (status === 400 || status === 401 || status === 403) throw new TicketRecordError('REFUSED');
  throw new TicketRecordError(status >= 500 ? 'UNREACHABLE' : 'UNEXPECTED_ANSWER');
}

/**
 * The recorder for a portal built with these settings. With none, nothing is
 * held. A failure is passed to `onError` as the portal's one log line (the step
 * and the error name) and is otherwise swallowed.
 */
export function createTicketRecorder(
  settings: ProvisioningSettings | undefined,
  onError?: (line: string) => void
): TicketRecorder {
  if (settings === undefined) return NO_RECORDER;
  return {
    record: async (tenantId, kind, text) => {
      try {
        await recordTicket(settings, tenantId, kind, text);
      } catch (error) {
        onError?.(portalErrorLine('handler', error));
      }
    },
  };
}
