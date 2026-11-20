/**
 * What the platform knows about a paying tenant's payment, and no more: an
 * opaque reference into whatever invoicing tool the owner uses, and whether the
 * tenant has paid. Defined once, here, and used by the table that stores it,
 * the owner role that writes it and the tenant portal that reads it.
 *
 * Nothing here is card data, a bank detail, a name, an address or a provider
 * secret, and nothing here can be: the reference is a short token of letters,
 * digits and four separators, and one that reads as a card number is refused.
 * A provider's own rules about what must not be stored are met by storing none
 * of it. The platform never calls a provider, so no key or token is held either.
 */

/** Whether a tenant has paid. The owner sets it in the console; nothing computes it. */
export const PAYMENT_STATES = ['unpaid', 'paid', 'overdue'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * The shape of a billing reference: 3 to 64 characters, starting with a letter
 * or digit, then letters, digits and `_ . : -` only. No space, no `@`, no `/`:
 * a name, an e-mail address, a URL or a free-text note cannot be written as one.
 */
export const BILLING_REFERENCE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,63}$';

/**
 * A reference that is twelve or more digits, each optionally preceded by one
 * separator (`4242-4242-4242-4242` and `4242424242424242` both match), reads as
 * a card number and is refused. A backstop for a mistaken paste, not a
 * detector: the real control is that the field is a reference and the owner's
 * invoicing tool holds the rest.
 */
export const CARD_NUMBER_LIKE_PATTERN = '^([_.:-]?[0-9]){12,}$';

const SHAPE = new RegExp(BILLING_REFERENCE_PATTERN);
const CARD_LIKE = new RegExp(CARD_NUMBER_LIKE_PATTERN);

/** A billing reference that does not fit the shape, or that reads as a card number. The value is not echoed. */
export class InvalidBillingReferenceError extends Error {
  constructor() {
    super('the billing reference is not an opaque reference');
    this.name = 'InvalidBillingReferenceError';
  }
}

/** A payment state outside the closed list. The value is not echoed. */
export class InvalidPaymentStateError extends Error {
  constructor() {
    super('the payment state is not one of the recognised states');
    this.name = 'InvalidPaymentStateError';
  }
}

/** Billing was asked of a tenant that cannot be billed: a demo slot pays nothing. */
export class TenantNotBillableError extends Error {
  constructor() {
    super('only a real tenant has a billing record');
    this.name = 'TenantNotBillableError';
  }
}

/**
 * Validates a billing reference. It is stored exactly as given (a reference is
 * case-sensitive in most tools), so nothing is trimmed or repaired: a value
 * that does not fit is refused.
 */
export function parseBillingReference(value: unknown): string {
  if (typeof value !== 'string' || !SHAPE.test(value) || CARD_LIKE.test(value)) {
    throw new InvalidBillingReferenceError();
  }
  return value;
}

/** Validates a payment state: an exact member of `PAYMENT_STATES`, never defaulted. */
export function parsePaymentState(value: unknown): PaymentState {
  if (typeof value !== 'string' || !(PAYMENT_STATES as readonly string[]).includes(value)) {
    throw new InvalidPaymentStateError();
  }
  return value as PaymentState;
}

/** A tenant's billing record as the console and the tenant portal read it. */
export interface BillingView {
  readonly tenantId: string;
  /** The opaque reference; null until the owner records one. */
  readonly billingReference: string | null;
  readonly paymentState: PaymentState;
  /** When the payment state last changed, by the database's clock. */
  readonly stateChangedAt: Date;
}

interface StoredBilling {
  readonly tenantId: string;
  readonly billingReference: string | null;
  readonly paymentState: string;
  readonly stateChangedAt: Date;
}

/** The view of a stored row; a stored state outside the list is refused, never shown. */
export function deriveBillingView(row: StoredBilling): BillingView {
  return {
    tenantId: row.tenantId,
    billingReference: row.billingReference,
    paymentState: parsePaymentState(row.paymentState),
    stateChangedAt: row.stateChangedAt,
  };
}
