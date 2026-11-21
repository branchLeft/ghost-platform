import { randomUUID } from 'node:crypto';
import type {
  Approval,
  Demo,
  DemoState,
  PromotionRequest,
  PromotionRequestState,
  PromotionTier,
  Tenant,
} from '../generated/index.js';

/**
 * The provisioning API's rules over a set of tenants and their requests, in
 * memory. The in-memory mock serves it as it is and loses it at exit; the
 * real service (./service.ts) adds `onChange`, which is called with the whole
 * state after every change so it can be written down, and restores it at start.
 * The rules below are the ones the contract (openapi.yaml) states, nothing more.
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
}

export interface StoreOptions {
  /** Time source; a test passes a fixed one. */
  readonly now?: () => Date;
  /** Id source; a test passes a counter. */
  readonly newId?: () => string;
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

export class ProvisioningStore {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly requests = new Map<string, PromotionRequest>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settleOnApprove: boolean;
  private readonly onChange: ((state: StoreState) => void) | undefined;
  private readonly refresh: (() => void) | undefined;
  private sequence = 0;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
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
    };
  }

  /** Replaces the whole state with one that was written down by `snapshot`. */
  restore(state: StoreState): void {
    this.tenants.clear();
    this.requests.clear();
    for (const record of state.tenants)
      this.tenants.set(record.tenant.tenant_id, structuredClone(record));
    for (const request of state.requests)
      this.requests.set(request.request_id, structuredClone(request));
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
    this.requests.set(request.request_id, request);
    try {
      this.persist();
    } catch (error) {
      this.requests.delete(request.request_id);
      throw error;
    }
    return { kind: 'recorded', request };
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
