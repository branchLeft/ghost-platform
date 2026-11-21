import { describe, expect, it } from 'vitest';
import {
  ENTRY_EXIT,
  PermanentStepError,
  STEP_IDS,
  TenantEntryHost,
  executeOnboarding,
  planOnboarding,
  type EntryReply,
  type EntryTransport,
  type EntryVerb,
  type ExecutePorts,
  type HostEntryPoint,
  type RecordedApproval,
  type RegisterEntry,
  type StepRequest,
  type TenantEntryInputs,
} from '../../src/index.js';
import { World } from '../support/doubles.js';

/** The first PublicPress tenant slot on the tenant ring: a branchLeft-owned demo site. */
const DEMO: RegisterEntry = {
  tenantId: 'demo-tenant',
  mediaFolder: 'demo-tenant',
  mediaBucket: 'branchleft-media-demo-tenant',
  appHostSlot: 'demo-tenant',
  appHostPort: 8101,
  appHostUid: 30001,
  hostnames: ['demo-tenant.sites.publicpress.co.uk'],
};
const DEMO_APPROVAL: RecordedApproval = {
  approvalId: 'DEMO_APPROVAL_PLACEHOLDER',
  tenantId: DEMO.tenantId,
  approvedAt: '2026-01-01T00:00:00Z',
  scopes: ['setup', 'web-address', 'first-deploy'],
};

const CANARY = 'EXAMPLE_SECRET_CANARY_7f3a';
const TEMPLATE = 'GHOST_DB_PASSWORD=\nGHOST_OWNER_EMAIL=\n';
const VALUES = { GHOST_DB_PASSWORD: CANARY, GHOST_OWNER_EMAIL: 'owner@example.invalid' };
const COMPOSE = 'name: demo-tenant\nservices: {}\n';
const PIN = `IMAGE=ghcr.io/branchleft/ghost-tenant@sha256:${'b'.repeat(64)}\n`;
const KEY = `ssh-ed25519 ${'A'.repeat(68)}`;

interface Sent {
  readonly verb: EntryVerb;
  readonly slug: string;
  readonly payload: Readonly<Record<string, unknown>> | undefined;
}

const reply = (code: number, stdout = '', stderr = ''): EntryReply => ({ code, stdout, stderr });

/**
 * A stand-in for the host's entry point that keeps what the real program keeps (a marker, the
 * secrets file, the stack, the unit's enable link, the slot) and refuses by the real program's
 * words when a verb comes out of order. The judge is stood in by two rules: a compose text that
 * says `privileged` is refused, and a pin that is not the tenant image is refused.
 */
class FakeEntryPoint implements EntryTransport {
  readonly sent: Sent[] = [];
  private readonly claimed = new Set<string>();
  private readonly secrets = new Set<string>();
  private readonly stacks = new Map<string, { compose: string; pin: string }>();
  private readonly enabled = new Set<string>();
  private readonly slots = new Set<string>();
  /** Per verb: how many leading requests get the host's busy answer. */
  busyFirst = new Map<EntryVerb, number>();
  /** Per verb: a reply to give instead of acting. */
  forced = new Map<EntryVerb, EntryReply>();

  verbs(): EntryVerb[] {
    return this.sent.map((s) => s.verb).filter((v) => v !== 'status');
  }

  has(slug: string): { claimed: boolean; stack: boolean; enabled: boolean; slot: boolean } {
    return {
      claimed: this.claimed.has(slug),
      stack: this.stacks.has(slug),
      enabled: this.enabled.has(slug),
      slot: this.slots.has(slug),
    };
  }

  async send(
    verb: EntryVerb,
    slug: string,
    payload?: Readonly<Record<string, unknown>>
  ): Promise<EntryReply> {
    this.sent.push({ verb, slug, payload });
    const busy = this.busyFirst.get(verb) ?? 0;
    if (this.sent.filter((s) => s.verb === verb).length <= busy) {
      return reply(ENTRY_EXIT.busy, '', 'busy\n');
    }
    const forced = this.forced.get(verb);
    if (forced !== undefined) return forced;
    const refuse = (word: string, detail = ''): EntryReply =>
      reply(ENTRY_EXIT.refused, '', `refused: ${word}\n${detail}`);
    if (verb === 'status') {
      if (!this.claimed.has(slug)) return reply(0, 'claimed-here=no\n');
      const yn = (b: boolean): string => (b ? 'yes' : 'no');
      return reply(
        0,
        [
          'claimed-here=yes',
          'volumes=yes',
          `secrets=${yn(this.secrets.has(slug))}`,
          `stack=${yn(this.stacks.has(slug))}`,
          `enabled=${yn(this.enabled.has(slug))}`,
          `slot=${yn(this.slots.has(slug))}`,
        ].join('\n') + '\n'
      );
    }
    if (verb === 'claim') {
      if (this.claimed.has(slug)) return refuse('slug-in-use');
      this.claimed.add(slug);
      return reply(0, 'claimed uid=30000 port_a=40000 port_b=40001 port_health=40002\n');
    }
    if (!this.claimed.has(slug)) return refuse('not-claimed-here');
    if (verb === 'secrets') {
      this.secrets.add(slug);
      return reply(0, 'written\n');
    }
    if (!this.secrets.has(slug)) return refuse('secrets-first');
    if (verb === 'stack') {
      if (this.stacks.has(slug)) return refuse('stack-exists');
      const compose = String(payload?.['compose_text']);
      const pin = String(payload?.['image_env_text']);
      if (compose.includes('privileged')) {
        return refuse('judge-refused', `${slug}: service app is privileged\n`);
      }
      if (!pin.startsWith('IMAGE=ghcr.io/branchleft/ghost-tenant@sha256:')) {
        return refuse('image-not-tenant');
      }
      this.stacks.set(slug, { compose, pin });
      return reply(0, 'compose.yml and image.env written\n');
    }
    if (verb === 'enable') {
      this.enabled.add(slug);
      return reply(0, 'enabled\n');
    }
    if (!this.enabled.has(slug)) return refuse('enable-first');
    if (verb === 'key') {
      if (this.slots.has(slug)) return refuse('slot-exists');
      this.slots.add(slug);
      return reply(0, 'slot granted\n');
    }
    return refuse('unknown-verb');
  }
}

class FakeInputs implements TenantEntryInputs {
  compose = COMPOSE;
  pin = PIN;
  readonly reads: string[] = [];

  async secrets(request: StepRequest) {
    this.reads.push(`secrets:${request.id}`);
    return { template: TEMPLATE, values: VALUES };
  }

  async stack(request: StepRequest) {
    this.reads.push(`stack:${request.id}`);
    return { composeText: this.compose, imageEnvText: this.pin };
  }

  async deployKey(request: StepRequest): Promise<string> {
    this.reads.push(`key:${request.id}`);
    return KEY;
  }
}

interface Rig {
  readonly world: World;
  readonly entry: FakeEntryPoint;
  readonly inputs: FakeInputs;
  readonly ports: ExecutePorts;
}

/** The controller's own plan for demo-tenant, with the app host served by the adapter. */
function rig(): Rig {
  const world = new World();
  world.entry = DEMO;
  world.approval = DEMO_APPROVAL;
  const entry = new FakeEntryPoint();
  const inputs = new FakeInputs();
  const base = world.ports();
  const adapter = new TenantEntryHost({
    transport: entry,
    inputs,
    fallback: base.hosts['app-host'],
  });
  return {
    world,
    entry,
    inputs,
    ports: { ...base, hosts: { ...base.hosts, 'app-host': adapter } },
  };
}

const request = (
  id: (typeof STEP_IDS)[number],
  inputs: StepRequest['inputs'] = {}
): StepRequest => ({
  key: `${DEMO.tenantId}/${id}`,
  id,
  idempotencyKey: `${DEMO.tenantId}/${id}@digest`,
  inputs: { slot: DEMO.appHostSlot, port: DEMO.appHostPort, uid: DEMO.appHostUid, ...inputs },
});

describe('the plan places the compose file between the secrets and the slot', () => {
  it('has a step for it after the secrets file and before the slot, on the app host', async () => {
    const plan = await planOnboarding(DEMO_APPROVAL.approvalId, rig().ports);
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const stack = byId.get('render-compose-file');
    expect(stack?.entryPoint).toBe('app-host');
    expect(stack?.dependsOn).toEqual(['render-host-secrets']);
    expect(byId.get('create-app-host-slot')?.dependsOn).toContain('render-compose-file');
    const order = plan.steps.map((s) => s.id);
    expect(order.indexOf('render-host-secrets')).toBeLessThan(order.indexOf('render-compose-file'));
    expect(order.indexOf('render-compose-file')).toBeLessThan(
      order.indexOf('create-app-host-slot')
    );
    expect(stack?.inputs).toEqual({ slot: 'demo-tenant', port: 8101, uid: 30001 });
  });
});

describe('TenantEntryHost: the controller plan for demo-tenant against a fake entry point', () => {
  it('sends claim, secrets, stack, enable and key, in that order, and the run completes', async () => {
    const { world, entry, ports } = rig();
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);

    expect(result.status).toBe('complete');
    expect(result.ran).toEqual(STEP_IDS.map((id) => `${DEMO.tenantId}/${id}`));
    expect(entry.verbs()).toEqual(['claim', 'secrets', 'stack', 'enable', 'key']);
    expect(new Set(entry.sent.map((s) => s.slug))).toEqual(new Set(['demo-tenant']));
    expect(entry.has('demo-tenant')).toEqual({
      claimed: true,
      stack: true,
      enabled: true,
      slot: true,
    });
    // The two app-host steps the adapter does not serve went to the configured entry point.
    const fallen = world.calls.filter((c) => c.entryPoint === 'app-host').map((c) => c.request.id);
    expect(fallen).toEqual(['first-deploy', 'create-owner-account']);
  });

  it('sends the stack between the secrets and the enable, never before the secrets', async () => {
    const { entry, ports } = rig();
    await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    const verbs = entry.verbs();
    expect(verbs.indexOf('secrets')).toBeLessThan(verbs.indexOf('stack'));
    expect(verbs.indexOf('stack')).toBeLessThan(verbs.indexOf('enable'));
  });

  it('hands the host exactly the renderer text, the secrets payload and the public key', async () => {
    const { entry, ports } = rig();
    await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    const payload = (verb: EntryVerb): unknown => entry.sent.find((s) => s.verb === verb)?.payload;
    expect(payload('stack')).toEqual({ compose_text: COMPOSE, image_env_text: PIN });
    expect(payload('secrets')).toEqual({ template: TEMPLATE, values: VALUES });
    expect(payload('key')).toEqual({ public_key: KEY });
    expect(payload('claim')).toBeUndefined();
    expect(payload('enable')).toBeUndefined();
  });

  it('sends nothing twice when the run is run again or a step is resumed', async () => {
    const { entry, ports } = rig();
    await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    const again = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(again.ran).toEqual([]);
    expect(entry.verbs()).toEqual(['claim', 'secrets', 'stack', 'enable', 'key']);

    // A step whose reply was lost: the host took effect, the controller runs the step again.
    const host = ports.hosts['app-host'];
    for (const id of [
      'render-host-secrets',
      'render-compose-file',
      'create-app-host-slot',
    ] as const) {
      await host.run(request(id));
    }
    expect(entry.verbs()).toEqual(['claim', 'secrets', 'stack', 'enable', 'key']);
  });

  it('resumes from a host that got part of the way, doing only what is left', async () => {
    const { entry, ports } = rig();
    const host = ports.hosts['app-host'];
    await host.run(request('render-host-secrets'));
    await host.run(request('render-compose-file'));
    entry.sent.length = 0;
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('complete');
    expect(entry.verbs()).toEqual(['enable', 'key']);
  });
});

describe('TenantEntryHost: what stops the run', () => {
  it('stops at the stack when the host refuses it, by name, and never enables the unit', async () => {
    const { world, entry, inputs, ports } = rig();
    inputs.compose = 'name: demo-tenant\nservices:\n  app:\n    privileged: true\n';
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);

    expect(result.status).toBe('stopped');
    expect(result.stoppedAt).toEqual({
      key: `${DEMO.tenantId}/render-compose-file`,
      reason: 'step-failed',
    });
    expect(entry.verbs()).toEqual(['claim', 'secrets', 'stack']);
    expect(entry.has('demo-tenant')).toMatchObject({ stack: false, enabled: false, slot: false });
    const failed = world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.reason).toContain('tenant entry refused stack with judge-refused');
    expect(failed?.reason).toContain('service app is privileged');
    // A refusal cannot be helped by trying again: one attempt.
    expect(entry.sent.filter((s) => s.verb === 'stack')).toHaveLength(1);
  });

  it('refuses a first pin that is not the tenant image, by name', async () => {
    const { entry, inputs, ports } = rig();
    inputs.pin = `IMAGE=example.invalid/app@sha256:${'c'.repeat(64)}\n`;
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    expect(entry.has('demo-tenant').stack).toBe(false);
  });

  it('never enables a unit whose stack is not in place, even if the host would', async () => {
    const { entry, ports } = rig();
    const host = ports.hosts['app-host'];
    await host.run(request('render-host-secrets'));
    await expect(host.run(request('create-app-host-slot'))).rejects.toBeInstanceOf(
      PermanentStepError
    );
    expect(entry.verbs()).toEqual(['claim', 'secrets']);
    expect(entry.has('demo-tenant').enabled).toBe(false);
  });

  it('sends no stack for a slot that was never claimed or whose secrets are not in place', async () => {
    const { entry, inputs, ports } = rig();
    const host = ports.hosts['app-host'];
    await expect(host.run(request('render-compose-file'))).rejects.toBeInstanceOf(
      PermanentStepError
    );
    expect(entry.verbs()).toEqual([]);
    expect(inputs.reads).toEqual([]);
  });

  it('retries a busy host and a failed step, and stops at once on a usage error', async () => {
    const { entry, ports } = rig();
    entry.busyFirst.set('claim', 2);
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('complete');
    expect(entry.sent.filter((s) => s.verb === 'claim')).toHaveLength(3);

    const failing = rig();
    failing.entry.forced.set('stack', reply(ENTRY_EXIT.failed, '', 'failed: judge-yaml-missing\n'));
    const stopped = await executeOnboarding(DEMO_APPROVAL.approvalId, failing.ports);
    expect(stopped.status).toBe('stopped');
    expect(failing.entry.sent.filter((s) => s.verb === 'stack')).toHaveLength(3);

    const usage = rig();
    usage.entry.forced.set('claim', reply(ENTRY_EXIT.usage, '', 'usage\n'));
    await executeOnboarding(DEMO_APPROVAL.approvalId, usage.ports);
    expect(usage.entry.sent.filter((s) => s.verb === 'claim')).toHaveLength(1);
  });

  it('refuses a step that names no slot', async () => {
    const { entry, ports } = rig();
    const host = ports.hosts['app-host'];
    for (const slot of [undefined, '', 7]) {
      const inputs: StepRequest['inputs'] = slot === undefined ? {} : { slot };
      const bare: StepRequest = { ...request('render-host-secrets'), inputs };
      await expect(host.run(bare)).rejects.toBeInstanceOf(PermanentStepError);
    }
    expect(entry.sent).toEqual([]);
  });

  it('passes every step it does not serve to the configured entry point and sends nothing', async () => {
    const entry = new FakeEntryPoint();
    const seen: string[] = [];
    const fallback: HostEntryPoint = { run: async (r) => void seen.push(r.id) };
    const adapter = new TenantEntryHost({ transport: entry, inputs: new FakeInputs(), fallback });
    for (const id of ['first-deploy', 'create-owner-account', 'push-first-commit'] as const) {
      await adapter.run(request(id));
    }
    expect(seen).toEqual(['first-deploy', 'create-owner-account', 'push-first-commit']);
    expect(entry.sent).toEqual([]);
  });
});

describe('TenantEntryHost: no secret value in what it says', () => {
  it('keeps the secrets values out of every error, even if the host repeats one', async () => {
    const { world, entry, ports } = rig();
    entry.forced.set(
      'secrets',
      reply(ENTRY_EXIT.refused, '', `refused: field-values\nrule about ${CANARY} and more\n`)
    );
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    const text = JSON.stringify([world.state.records, world.events]);
    expect(text).not.toContain(CANARY);
    expect(text).toContain('tenant entry refused secrets with field-values');
  });

  it('keeps the public key out of an error and names only a plain word as the reason', async () => {
    const { world, entry, ports } = rig();
    entry.forced.set('key', reply(ENTRY_EXIT.refused, '', `refused: ${KEY}\n${KEY}\n`));
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    const text = JSON.stringify(world.state.records);
    expect(text).not.toContain(KEY);
    expect(text).toContain('refused key with unreadable');
  });

  it('treats a status it cannot read as a failure to retry, not as an empty host', async () => {
    const { entry, ports } = rig();
    entry.forced.set('status', reply(0, 'nonsense\n'));
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    expect(entry.verbs()).toEqual([]);
  });
});
