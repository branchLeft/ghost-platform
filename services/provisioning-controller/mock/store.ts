import { randomUUID } from 'node:crypto';
import type {
  Approval,
  Demo,
  DemoState,
  PromotionRequest,
  PromotionRequestState,
  PromotionTier,
  Tenant,
} from '../src/generated/index.js';

/**
 * The mock's whole state, in memory and lost at exit. Nothing here is a
 * migration or a table: the real service's storage is a later waypoint's. The
 * rules below are the ones the contract (openapi.yaml) states, nothing more.
 */

/** The demo states a promotion can be asked from (the portal's `demoPromotion` precondition). */
const PROMOTABLE: readonly DemoState[] = ['LIVE', 'EXTENDED', 'EXPIRING'];

/** What one approval covers, in the order the controller's plan takes them. */
const APPROVAL_SCOPES: Approval['scopes'] = ['setup', 'web-address', 'first-deploy'];

const DEMO_TERM_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

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

interface TenantRecord {
  tenant: Tenant;
  demo: Demo;
}

export class MockStore {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly requests = new Map<string, PromotionRequest>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settleOnApprove: boolean;
  private sequence = 0;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.settleOnApprove = options.settleOnApprove ?? true;
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
    return this.tenants.has(tenantId);
  }

  getDemo(tenantId: string): Demo | undefined {
    return this.tenants.get(tenantId)?.demo;
  }

  getTenant(tenantId: string): Tenant | undefined {
    return this.tenants.get(tenantId)?.tenant;
  }

  listRequests(state: PromotionRequestState | undefined): PromotionRequest[] {
    return [...this.requests.values()]
      .filter((request) => state === undefined || request.state === state)
      .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  }

  createRequest(tenantId: string, tier: PromotionTier): CreateOutcome {
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
    return { kind: 'recorded', request };
  }

  /**
   * Records one approval. An already approved request is returned exactly as
   * it was, so a second approve changes nothing and answers the same body.
   */
  approve(requestId: string): ApproveOutcome {
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
    this.requests.set(requestId, approved);

    const record = this.tenants.get(existing.tenant_id);
    if (record !== undefined) {
      record.demo = { ...record.demo, state: 'PROMOTING' };
      record.tenant = { ...record.tenant, tier: 'essentials', state: 'provisioning' };
      if (this.settleOnApprove) this.settle(existing.tenant_id);
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
