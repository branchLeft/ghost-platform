import { randomUUID } from 'node:crypto';
import type {
  Approval,
  Demo,
  DemoState,
  PromotionRequest,
  PromotionRequestState,
  PromotionTier,
  Tenant,
  Ticket,
  TicketKind,
  TicketState,
} from '../generated/index.js';
import { canMoveTicket, OPEN_TICKET_LIMIT } from './ticketLifecycle.js';

/**
 * The provisioning API's rules over a set of tenants and their requests, in
 * memory. The in-memory mock serves it as it is and loses it at exit; the
 * real service (./service.ts) adds `onChange`, which is called with the whole
 * state after every change so it can be written down, and restores it at start.
 * The rules below are the ones the contract (openapi.yaml) states, nothing more.
 *
 * Tickets are the owner's record of every contact request a tenant raised. A
 * promotion request records its own ticket in the same change; a support
 * ticket or an enquiry is recorded by `createTicket`.
 */

/** The demo states a promotion can be asked from (the portal's `demoPromotion` precondition). */
const PROMOTABLE: readonly DemoState[] = ['LIVE', 'EXTENDED', 'EXPIRING'];

/** What one approval covers, in the order the controller's plan takes them. */
const APPROVAL_SCOPES: Approval['scopes'] = ['setup', 'web-address', 'first-deploy'];

const DEMO_TERM_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One tenant's side of the state: the tenant as the API reports it, and its demo. */
export interface TenantRecord {
  tenant: Tenant;
  demo: Demo;
}

/** The whole state, as it is written down and read back. */
export interface StoreState {
  readonly version: 1;
  readonly sequence: number;
  readonly tenants: readonly TenantRecord[];
  readonly requests: readonly PromotionRequest[];
  readonly tickets: readonly Ticket[];
}

export interface StoreOptions {
  /** Time source; a test passes a fixed one. */
  readonly now?: () => Date;
  /** Id source; a test passes a counter. */
  readonly newId?: () => string;
  /** Id source for tickets alone, so recording one never moves the ids of requests. */
  readonly newTicketId?: () => string;
  /**
   * Whether approving also finishes provisioning, so the tenant is `live` the
   * moment the request is approved. Off, the tenant stays `provisioning` until
   * `settle` is called, which is how a test sees the in-between state.
   * @default true
   */
  readonly settleOnApprove?: boolean;
  /**
   * Called with the whole state after every change, before the change is
   * answered. If it throws the change is undone and the throw goes on, so
   * nothing is answered that was not written down.
   */
  readonly onChange?: (state: StoreState) => void;
  /** Called first in every read and write, so a source of tenants can be looked at again. */
  readonly refresh?: () => void;
}

export type CreateOutcome =
  | { readonly kind: 'recorded'; readonly request: PromotionRequest }
  | { readonly kind: 'no-demo' }
  | { readonly kind: 'not-promotable' }
  | { readonly kind: 'other-request-open' };

export type ApproveOutcome =
  | { readonly kind: 'approved'; readonly request: PromotionRequest }
  | { readonly kind: 'no-request' }
  | { readonly kind: 'not-approvable' };

export type CreateTicketOutcome =
  { readonly kind: 'recorded'; readonly ticket: Ticket } | { readonly kind: 'limit' };

export type MoveTicketOutcome =
  | { readonly kind: 'moved'; readonly ticket: Ticket }
  | { readonly kind: 'no-ticket' }
  | { readonly kind: 'illegal' };

/** What a tenant wrote on a form; an Essentials request has none. */
export interface TicketText {
  readonly contact: string;
  readonly message: string;
}

export class ProvisioningStore {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly requests = new Map<string, PromotionRequest>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newTicketId: () => string;
  private readonly settleOnApprove: boolean;
  private readonly onChange: ((state: StoreState) => void) | undefined;
  private readonly refresh: (() => void) | undefined;
  private sequence = 0;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.newTicketId = options.newTicketId ?? randomUUID;
    this.settleOnApprove = options.settleOnApprove ?? true;
    this.onChange = options.onChange;
    this.refresh = options.refresh;
  }

  /** The whole state, copied, in the order it was made. */
  snapshot(): StoreState {
    return {
      version: 1,
      sequence: this.sequence,
      tenants: [...this.tenants.values()].map((record) => structuredClone(record)),
      requests: [...this.requests.values()].map((request) => structuredClone(request)),
      tickets: [...this.tickets.values()].map((ticket) => structuredClone(ticket)),
    };
  }

  /** Replaces the whole state with one that was written down by `snapshot`. */
  restore(state: StoreState): void {
    this.tenants.clear();
    this.requests.clear();
    this.tickets.clear();
    for (const record of state.tenants)
      this.tenants.set(record.tenant.tenant_id, structuredClone(record));
    for (const request of state.requests)
      this.requests.set(request.request_id, structuredClone(request));
    for (const ticket of state.tickets) this.tickets.set(ticket.ticket_id, structuredClone(ticket));
    this.sequence = state.sequence;
  }

  /**
   * Adds a tenant whose demo exists already, as a register of demos names it, or
   * brings an existing tenant's demo up to what the register now says. A tenant
   * past the demo tier is the store's own and the register no longer speaks for
   * it. The demo's id never changes: requests are recorded against it. Returns
   * whether anything changed.
   */
  seedDemo(demo: Demo, tenantId: string, hostnames: readonly string[]): boolean {
    const existing = this.tenants.get(tenantId);
    if (existing === undefined) {
      this.tenants.set(tenantId, {
        tenant: {
          tenant_id: tenantId,
          tier: 'demo',
          state: 'live',
          invoice_ref: null,
          hostnames: [...hostnames],
        },
        demo: { ...demo },
      });
      return true;
    }
    if (existing.tenant.tier !== 'demo') return false;
    const next: Demo = { ...demo, demo_id: existing.demo.demo_id };
    const same =
      JSON.stringify(next) === JSON.stringify(existing.demo) &&
      JSON.stringify(hostnames) === JSON.stringify(existing.tenant.hostnames);
    if (same) return false;
    existing.demo = next;
    existing.tenant = { ...existing.tenant, hostnames: [...hostnames] };
    return true;
  }

  private persist(): void {
    this.onChange?.(this.snapshot());
  }

  /** Adds a demo tenant with a `LIVE` demo, as a prospect who has signed in would have. */
  seedDemoTenant(tenantId: string, demoState: DemoState = 'LIVE'): void {
    this.sequence += 1;
    const label = `demo-${String(this.sequence)}`;
    const expires = new Date(this.now().getTime() + DEMO_TERM_DAYS * DAY_MS);
    this.tenants.set(tenantId, {
      tenant: {
        tenant_id: tenantId,
        tier: 'demo',
        state: 'live',
        invoice_ref: null,
        hostnames: [`${label}.example.test`],
      },
      demo: {
        demo_id: this.newId(),
        address: `${label}.example.test`,
        state: demoState,
        expires_at: expires.toISOString(),
      },
    });
  }

  hasTenant(tenantId: string): boolean {
    this.refresh?.();
    return this.tenants.has(tenantId);
  }

  getDemo(tenantId: string): Demo | undefined {
    this.refresh?.();
    return this.tenants.get(tenantId)?.demo;
  }

  getTenant(tenantId: string): Tenant | undefined {
    this.refresh?.();
    return this.tenants.get(tenantId)?.tenant;
  }

  listRequests(state: PromotionRequestState | undefined): PromotionRequest[] {
    this.refresh?.();
    return [...this.requests.values()]
      .filter((request) => state === undefined || request.state === state)
      .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  }

  createRequest(tenantId: string, tier: PromotionTier): CreateOutcome {
    this.refresh?.();
    const record = this.tenants.get(tenantId);
    if (record === undefined) return { kind: 'no-demo' };
    const open = [...this.requests.values()].find(
      (request) => request.tenant_id === tenantId && request.state === 'pending'
    );
    if (open !== undefined) {
      return open.tier === tier
        ? { kind: 'recorded', request: open }
        : { kind: 'other-request-open' };
    }
    if (!PROMOTABLE.includes(record.demo.state)) return { kind: 'not-promotable' };
    const request: PromotionRequest = {
      request_id: this.newId(),
      tenant_id: tenantId,
      demo_id: record.demo.demo_id,
      tier,
      state: 'pending',
      requested_at: this.now().toISOString(),
      approval: null,
    };
    const ticket = this.newTicket(tenantId, tier, request.requested_at, null, request.request_id);
    this.requests.set(request.request_id, request);
    this.tickets.set(ticket.ticket_id, ticket);
    try {
      this.persist();
    } catch (error) {
      this.requests.delete(request.request_id);
      this.tickets.delete(ticket.ticket_id);
      throw error;
    }
    return { kind: 'recorded', request };
  }

  private newTicket(
    tenantId: string,
    kind: TicketKind,
    at: string,
    text: TicketText | null,
    requestId: string | null
  ): Ticket {
    return {
      ticket_id: this.newTicketId(),
      tenant_id: tenantId,
      kind,
      state: 'new',
      contact: text?.contact ?? null,
      message: text?.message ?? null,
      request_id: requestId,
      created_at: at,
      updated_at: at,
      history: [{ state: 'new', at }],
    };
  }

  /** Every ticket, oldest first, optionally only those in one state and of one kind. */
  listTickets(state: TicketState | undefined, kind: TicketKind | undefined): Ticket[] {
    this.refresh?.();
    return [...this.tickets.values()]
      .filter((ticket) => state === undefined || ticket.state === state)
      .filter((ticket) => kind === undefined || ticket.kind === kind)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * Records a support ticket or an enquiry for a tenant, in state `new`. A tenant
   * that already holds the limit of tickets that are not closed records nothing.
   */
  createTicket(
    tenantId: string,
    kind: Exclude<TicketKind, 'essentials'>,
    text: TicketText
  ): CreateTicketOutcome {
    this.refresh?.();
    const held = [...this.tickets.values()].filter(
      (ticket) => ticket.tenant_id === tenantId && ticket.state !== 'closed'
    ).length;
    if (held >= OPEN_TICKET_LIMIT) return { kind: 'limit' };
    const ticket = this.newTicket(tenantId, kind, this.now().toISOString(), text, null);
    this.tickets.set(ticket.ticket_id, ticket);
    try {
      this.persist();
    } catch (error) {
      this.tickets.delete(ticket.ticket_id);
      throw error;
    }
    return { kind: 'recorded', ticket };
  }

  /**
   * Moves a ticket to another state if the lifecycle allows it, and records the
   * move in its history. A move the lifecycle refuses, to the state the ticket
   * is already in included, changes nothing.
   */
  moveTicket(ticketId: string, to: TicketState): MoveTicketOutcome {
    this.refresh?.();
    const existing = this.tickets.get(ticketId);
    if (existing === undefined) return { kind: 'no-ticket' };
    if (!canMoveTicket(existing.state, to)) return { kind: 'illegal' };
    const at = this.now().toISOString();
    const moved: Ticket = {
      ...existing,
      state: to,
      updated_at: at,
      history: [...existing.history, { state: to, at }],
    };
    this.tickets.set(ticketId, moved);
    try {
      this.persist();
    } catch (error) {
      this.tickets.set(ticketId, existing);
      throw error;
    }
    return { kind: 'moved', ticket: moved };
  }

  /**
   * Records one approval. An already approved request is returned exactly as
   * it was, so a second approve changes nothing and answers the same body.
   */
  approve(requestId: string): ApproveOutcome {
    this.refresh?.();
    const existing = this.requests.get(requestId);
    if (existing === undefined) return { kind: 'no-request' };
    if (existing.tier !== 'essentials') return { kind: 'not-approvable' };
    if (existing.state === 'approved') return { kind: 'approved', request: existing };

    const approved: PromotionRequest = {
      ...existing,
      state: 'approved',
      approval: {
        approval_id: this.newId(),
        tenant_id: existing.tenant_id,
        approved_at: this.now().toISOString(),
        scopes: [...APPROVAL_SCOPES],
      },
    };
    const record = this.tenants.get(existing.tenant_id);
    // Fields are replaced, never edited in place, so holding them is a copy.
    const before = record === undefined ? undefined : { tenant: record.tenant, demo: record.demo };
    const sequenceBefore = this.sequence;
    this.requests.set(requestId, approved);

    if (record !== undefined) {
      record.demo = { ...record.demo, state: 'PROMOTING' };
      record.tenant = { ...record.tenant, tier: 'essentials', state: 'provisioning' };
      if (this.settleOnApprove) this.settle(existing.tenant_id);
    }
    try {
      this.persist();
    } catch (error) {
      this.requests.set(requestId, existing);
      if (record !== undefined && before !== undefined) {
        record.tenant = before.tenant;
        record.demo = before.demo;
      }
      this.sequence = sequenceBefore;
      throw error;
    }
    return { kind: 'approved', request: approved };
  }

  /** Finishes provisioning a tenant that was approved: it gets its site, hostnames and invoice reference. */
  settle(tenantId: string): void {
    const record = this.tenants.get(tenantId);
    if (record === undefined || record.tenant.tier !== 'essentials') return;
    this.sequence += 1;
    record.demo = { ...record.demo, state: 'PROMOTED' };
    record.tenant = {
      ...record.tenant,
      state: 'live',
      invoice_ref: `MOCK_INVOICE_REF_${String(this.sequence)}`,
      hostnames: [`essentials-${String(this.sequence)}.example.test`],
    };
  }
}

/** The in-memory mock's name for the same store. */
export { ProvisioningStore as MockStore };
