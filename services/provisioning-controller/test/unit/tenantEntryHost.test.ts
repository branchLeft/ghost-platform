import { describe, expect, it } from 'vitest';
import {
  ENTRY_EXIT,
  PermanentStepError,
  STEP_IDS,
  TenantEntryHost,
  executeOnboarding,
  planOnboarding,
  type EntryClaim,
  type EntryReply,
  type EntryTransport,
  type EntryVerb,
  type ExecutePorts,
  type HostEntryPoint,
  type OwnerParameters,
  type RecordedApproval,
  type RegisterEntry,
  type StackParameters,
  type StepRequest,
  type TenantEntryInputs,
} from '../../src/index.js';
import { World } from '../support/doubles.js';

/** The first PublicPress tenant slot on the tenant ring: a branchLeft-owned demo site. */
const DEMO: RegisterEntry = {
  tenantId: 'demo-tenant',
  mediaFolder: 'demo-tenant',
  stateFolder: 'STATE_FOLDER_PLACEHOLDER',
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
/** What the controller sends for the stack: parameters only, and a reference to a secret's name. */
const PARAMETERS: StackParameters = {
  size: 'standard',
  mail: true,
  environment: {
    url: 'https://demo-tenant.sites.publicpress.co.uk',
    database__connection__password: { secret: 'GHOST_DB_PASSWORD' },
    mail__options__port: 587,
    privacy__useGravatar: false,
  },
};
/** The numbers the fake host hands out, which are not the register's (uid 30001, port 8101). */
const CLAIM: EntryClaim = { uid: 30000, portA: 40000, portB: 40001, portHealth: 40002 };
const KEY = `ssh-ed25519 ${'A'.repeat(68)}`;
/** The owner's address lives in the host's secrets file; the controller's owner step never holds it. */
const OWNER_EMAIL = VALUES.GHOST_OWNER_EMAIL;
/** What the owner step may carry: a display name, the site's address and title, a colour. */
const OWNER: OwnerParameters = {
  colour: 'a',
  name: 'Demo Owner',
  siteUrl: 'https://demo-tenant.sites.publicpress.co.uk',
  siteTitle: 'Demo site',
};

interface Sent {
  readonly verb: EntryVerb;
  readonly slug: string;
  readonly payload: Readonly<Record<string, unknown>> | undefined;
}

const reply = (code: number, stdout = '', stderr = ''): EntryReply => ({ code, stdout, stderr });

/**
 * A stand-in for the host's entry point that keeps what the real program keeps (a marker, the
 * secrets file, the stack, the unit's enable link, the slot) and refuses by the real program's
 * words when a verb comes out of order. It takes the real verb's request: exactly `size`, `mail`
 * and `environment`, and it refuses a pin or a compose text by name. The judge is stood in by one
 * rule: a reference to a key the secrets file does not hold is refused.
 */
class FakeEntryPoint implements EntryTransport {
  readonly sent: Sent[] = [];
  private readonly claimed = new Set<string>();
  private readonly secrets = new Set<string>();
  private readonly stacks = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly enabled = new Set<string>();
  private readonly slots = new Set<string>();
  /** Per verb: how many leading requests get the host's busy answer. */
  busyFirst = new Map<EntryVerb, number>();
  /** Per verb: a reply to give instead of acting. */
  forced = new Map<EntryVerb, EntryReply>();
  /** Whether the host has the platform's owner script (and node) installed. */
  ownerProgram = true;
  /** The colours whose container is running. */
  running = new Set<string>(['a', 'b']);
  /** Leading `owner` requests that find no running container. */
  notRunningFirst = 0;
  /** The address a Ghost was already claimed by, if someone set it up first. */
  ghostClaimedBy: string | undefined;
  /** The owners the host's script made, by slug. */
  readonly owners = new Map<string, string>();
  private readonly emails = new Map<string, string>();

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
          `uid=${CLAIM.uid}`,
          `port_a=${CLAIM.portA}`,
          `port_b=${CLAIM.portB}`,
          `port_health=${CLAIM.portHealth}`,
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
      return reply(
        0,
        `claimed uid=${CLAIM.uid} port_a=${CLAIM.portA} port_b=${CLAIM.portB} port_health=${CLAIM.portHealth}\n`
      );
    }
    if (!this.claimed.has(slug)) return refuse('not-claimed-here');
    if (verb === 'secrets') {
      this.secrets.add(slug);
      const values = (payload?.['values'] ?? {}) as Record<string, string>;
      this.emails.set(slug, values['GHOST_OWNER_EMAIL'] ?? '');
      return reply(0, 'written\n');
    }
    if (!this.secrets.has(slug)) return refuse('secrets-first');
    if (verb === 'stack') {
      const keys = Object.keys(payload ?? {});
      if (keys.includes('image_env_text')) return refuse('pin-not-accepted');
      if (keys.includes('compose_text')) return refuse('compose-not-accepted');
      if (keys.sort().join() !== 'environment,mail,size') return refuse('payload-keys');
      const given = JSON.stringify(payload);
      const held = this.stacks.get(slug);
      if (held !== undefined) {
        return JSON.stringify(held) === given
          ? reply(0, 'compose.yml already in place\n')
          : refuse('stack-exists');
      }
      if (given.includes('GHOST_MISSING')) {
        return refuse('judge-refused', `${slug}: secrets file has no key GHOST_MISSING\n`);
      }
      this.stacks.set(slug, payload ?? {});
      return reply(0, 'compose.yml written\n');
    }
    if (verb === 'enable') {
      this.enabled.add(slug);
      return reply(0, 'enabled\n');
    }
    if (!this.enabled.has(slug)) return refuse('enable-first');
    if (verb === 'owner') {
      if (
        Object.keys(payload ?? {})
          .sort()
          .join() !== 'colour,name,site_title,site_url'
      ) {
        return refuse('payload-keys');
      }
      if (this.sent.filter((s) => s.verb === 'owner').length <= this.notRunningFirst) {
        return refuse('container-not-running');
      }
      if (!this.running.has(String(payload?.['colour']))) return refuse('container-not-running');
      if (!this.ownerProgram) return reply(ENTRY_EXIT.failed, '', 'failed: program-missing\n');
      // The script reads the address from the secrets file; a Ghost claimed by another address is refused.
      const email = this.emails.get(slug) ?? '';
      if (this.ghostClaimedBy !== undefined && this.ghostClaimedBy !== email) {
        return reply(
          ENTRY_EXIT.failed,
          '',
          `failed: owner\nGhost is already set up with ${this.ghostClaimedBy}, not ${email}\n`
        );
      }
      if (this.owners.has(slug) || this.ghostClaimedBy !== undefined) {
        return reply(0, '{"created":false,"alreadySetUp":true}\n');
      }
      this.owners.set(slug, email);
      return reply(0, '{"created":true,"alreadySetUp":false,"linkRequested":true}\n');
    }
    if (verb === 'key') {
      if (this.slots.has(slug)) return refuse('slot-exists');
      this.slots.add(slug);
      return reply(0, 'slot granted\n');
    }
    return refuse('unknown-verb');
  }
}

class FakeInputs implements TenantEntryInputs {
  parameters: StackParameters = PARAMETERS;
  ownerParameters: OwnerParameters = OWNER;
  /** Extra fields a careless provider might return beside the owner parameters. */
  ownerExtra: Readonly<Record<string, unknown>> = {};
  /** Extra fields a careless provider might return beside the parameters. */
  extra: Readonly<Record<string, unknown>> = {};
  readonly reads: string[] = [];
  readonly claims: EntryClaim[] = [];

  async secrets(request: StepRequest) {
    this.reads.push(`secrets:${request.id}`);
    return { template: TEMPLATE, values: VALUES };
  }

  async stack(request: StepRequest, claim: EntryClaim): Promise<StackParameters> {
    this.reads.push(`stack:${request.id}`);
    this.claims.push(claim);
    return { ...this.parameters, ...this.extra } as StackParameters;
  }

  async deployKey(request: StepRequest): Promise<string> {
    this.reads.push(`key:${request.id}`);
    return KEY;
  }

  async owner(request: StepRequest): Promise<OwnerParameters> {
    this.reads.push(`owner:${request.id}`);
    return { ...this.ownerParameters, ...this.ownerExtra } as OwnerParameters;
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
    expect(entry.verbs()).toEqual(['claim', 'secrets', 'stack', 'enable', 'key', 'owner']);
    expect(new Set(entry.sent.map((s) => s.slug))).toEqual(new Set(['demo-tenant']));
    expect(entry.has('demo-tenant')).toEqual({
      claimed: true,
      stack: true,
      enabled: true,
      slot: true,
    });
    // The app-host step the adapter does not serve went to the configured entry point.
    const fallen = world.calls.filter((c) => c.entryPoint === 'app-host').map((c) => c.request.id);
    expect(fallen).toEqual(['first-deploy']);
  });

  it('sends the stack between the secrets and the enable, never before the secrets', async () => {
    const { entry, ports } = rig();
    await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    const verbs = entry.verbs();
    expect(verbs.indexOf('secrets')).toBeLessThan(verbs.indexOf('stack'));
    expect(verbs.indexOf('stack')).toBeLessThan(verbs.indexOf('enable'));
  });

  it('hands the host exactly the stack parameters, the secrets payload and the public key', async () => {
    const { entry, inputs, ports } = rig();
    await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    const payload = (verb: EntryVerb): unknown => entry.sent.find((s) => s.verb === verb)?.payload;
    expect(payload('stack')).toEqual(PARAMETERS);
    // The host's claim, not the register's uid and port, is what the provider is given.
    expect(inputs.claims).toEqual([CLAIM]);
    expect(CLAIM.uid).not.toBe(DEMO.appHostUid);
    expect(CLAIM.portA).not.toBe(DEMO.appHostPort);
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
    expect(entry.verbs()).toEqual(['claim', 'secrets', 'stack', 'enable', 'key', 'owner']);

    // A step whose reply was lost: the host took effect, the controller runs the step again.
    const host = ports.hosts['app-host'];
    for (const id of [
      'render-host-secrets',
      'render-compose-file',
      'create-app-host-slot',
    ] as const) {
      await host.run(request(id));
    }
    expect(entry.verbs()).toEqual(['claim', 'secrets', 'stack', 'enable', 'key', 'owner']);
  });

  it('resumes from a host that got part of the way, doing only what is left', async () => {
    const { entry, ports } = rig();
    const host = ports.hosts['app-host'];
    await host.run(request('render-host-secrets'));
    await host.run(request('render-compose-file'));
    entry.sent.length = 0;
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('complete');
    expect(entry.verbs()).toEqual(['enable', 'key', 'owner']);
  });
});

describe('TenantEntryHost: what stops the run', () => {
  it('stops at the stack when the host refuses it, by name, and never enables the unit', async () => {
    const { world, entry, inputs, ports } = rig();
    inputs.parameters = {
      ...PARAMETERS,
      environment: { ...PARAMETERS.environment, x: { secret: 'GHOST_MISSING' } },
    };
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
    expect(failed?.reason).toContain('secrets file has no key GHOST_MISSING');
    // A refusal cannot be helped by trying again: one attempt.
    expect(entry.sent.filter((s) => s.verb === 'stack')).toHaveLength(1);
  });

  it('never sends a compose text or an image pin, whatever a provider returns beside the parameters', async () => {
    const { entry, inputs, ports } = rig();
    inputs.extra = {
      compose_text: 'name: x\nservices: {}\n',
      image_env_text: `IMAGE=ghcr.io/branchleft/ghost-tenant@sha256:${'b'.repeat(64)}\n`,
      volumes: ['/:/host'],
      user: '0:0',
    };
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('complete');
    const stack = entry.sent.find((s) => s.verb === 'stack');
    expect(Object.keys(stack?.payload ?? {}).sort()).toEqual(['environment', 'mail', 'size']);
    expect(JSON.stringify(entry.sent)).not.toContain('image_env_text');
    expect(JSON.stringify(entry.sent)).not.toContain('compose_text');
  });

  it('stops by name when the host refuses a parameter, and tries once', async () => {
    const { world, entry, ports } = rig();
    entry.forced.set('stack', reply(ENTRY_EXIT.refused, '', 'refused: field-environment\n'));
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    expect(entry.sent.filter((s) => s.verb === 'stack')).toHaveLength(1);
    const failed = world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.reason).toContain('tenant entry refused stack with field-environment');
  });

  it('sends the same stack again after a lost reply and is told it is in place', async () => {
    const { entry, ports } = rig();
    const host = ports.hosts['app-host'];
    await host.run(request('render-host-secrets'));
    entry.forced.set(
      'status',
      reply(
        0,
        'claimed-here=yes\nuid=30000\nport_a=40000\nport_b=40001\nport_health=40002\nvolumes=yes\nsecrets=yes\nstack=no\nenabled=no\nslot=no\n'
      )
    );
    await host.run(request('render-compose-file'));
    await host.run(request('render-compose-file'));
    expect(entry.sent.filter((s) => s.verb === 'stack')).toHaveLength(2);
    expect(entry.has('demo-tenant').stack).toBe(true);
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
    for (const id of ['first-deploy', 'push-first-commit', 'enrol-backups'] as const) {
      await adapter.run(request(id));
    }
    expect(seen).toEqual(['first-deploy', 'push-first-commit', 'enrol-backups']);
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

  it('treats a claimed slug whose status carries no uid or ports as a failure to retry', async () => {
    const { entry, inputs, ports } = rig();
    entry.forced.set('status', reply(0, 'claimed-here=yes\nvolumes=yes\nsecrets=yes\n'));
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    expect(inputs.reads).toEqual([]);
    expect(entry.verbs()).toEqual([]);
  });

  it('gives a deployment the claim the host holds for a slug, and nothing for one never claimed', async () => {
    const entry = new FakeEntryPoint();
    const adapter = new TenantEntryHost({
      transport: entry,
      inputs: new FakeInputs(),
      fallback: { run: async () => undefined },
    });
    expect(await adapter.claimOf('demo-tenant')).toBeNull();
    await adapter.run(request('render-host-secrets'));
    expect(await adapter.claimOf('demo-tenant')).toEqual(CLAIM);
  });

  it('treats a status it cannot read as a failure to retry, not as an empty host', async () => {
    const { entry, ports } = rig();
    entry.forced.set('status', reply(0, 'nonsense\n'));
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    expect(entry.verbs()).toEqual([]);
  });
});

describe('TenantEntryHost: create-owner-account through the host’s owner verb', () => {
  const ownerCalls = (entry: FakeEntryPoint): Sent[] =>
    entry.sent.filter((s) => s.verb === 'owner');

  it('sends the owner verb last, with the four fields and nothing that could be an address', async () => {
    const { world, entry, ports } = rig();
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);

    expect(result.status).toBe('complete');
    expect(result.ran).toContain(`${DEMO.tenantId}/create-owner-account`);
    const sent = ownerCalls(entry);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({
      colour: 'a',
      name: OWNER.name,
      site_url: OWNER.siteUrl,
      site_title: OWNER.siteTitle,
    });
    // The host's script made the owner from the secrets file it holds.
    expect(entry.owners.get('demo-tenant')).toBe(OWNER_EMAIL);
    // The owner's address went to the host with the secrets and nowhere else: not in the owner
    // request, the run record, or anything the console was told.
    expect(JSON.stringify(sent)).not.toContain('@');
    const recorded = JSON.stringify([world.state.records, world.events]);
    expect(recorded).not.toContain(OWNER_EMAIL);
    expect(recorded).not.toContain(CANARY);
    expect(entry.verbs().at(-1)).toBe('owner');
  });

  it('is recorded failed, and the run stops before the hostname, when the host has no owner script', async () => {
    const red = rig();
    red.entry.ownerProgram = false;
    const stopped = await executeOnboarding(DEMO_APPROVAL.approvalId, red.ports);
    expect(stopped.status).toBe('stopped');
    expect(stopped.stoppedAt).toEqual({
      key: `${DEMO.tenantId}/create-owner-account`,
      reason: 'step-failed',
    });
    const failed = red.world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.reason).toContain('tenant entry owner failed (failed: program-missing)');
    // A failed host program is retried, then given up on: three attempts.
    expect(ownerCalls(red.entry)).toHaveLength(3);
    const done = red.world.state.completeKeys();
    expect(done).not.toContain(`${DEMO.tenantId}/create-owner-account`);
    expect(done).not.toContain(`${DEMO.tenantId}/publish-hostnames`);
    expect(red.entry.owners.size).toBe(0);

    // With the script in place the same plan completes and the owner exists.
    const green = rig();
    const finished = await executeOnboarding(DEMO_APPROVAL.approvalId, green.ports);
    expect(finished.status).toBe('complete');
    expect(green.world.state.completeKeys()).toContain(`${DEMO.tenantId}/create-owner-account`);
    expect(green.entry.owners.size).toBe(1);
  });

  it('is safe to run again: the host reports the owner already set up and nothing is made twice', async () => {
    const { entry, ports } = rig();
    await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    // A reply lost after the host took effect: the controller runs the step again.
    await ports.hosts['app-host'].run(request('create-owner-account'));
    expect(ownerCalls(entry)).toHaveLength(2);
    expect(entry.owners.size).toBe(1);
  });

  it('stops, and never repeats an address, when the Ghost was claimed by someone else first', async () => {
    const { world, entry, ports } = rig();
    entry.ghostClaimedBy = 'someone-else@example.invalid';
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    expect(result.stoppedAt?.key).toBe(`${DEMO.tenantId}/create-owner-account`);
    expect(entry.owners.size).toBe(0);
    const recorded = JSON.stringify([world.state.records, world.events]);
    expect(recorded).not.toContain('someone-else@example.invalid');
    expect(recorded).not.toContain(OWNER_EMAIL);
  });

  it('masks an address in a refusal’s detail', async () => {
    const { world, entry, ports } = rig();
    entry.forced.set(
      'owner',
      reply(
        ENTRY_EXIT.refused,
        '',
        'refused: field-name\nname rule failed for x.y@example.invalid\n'
      )
    );
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('stopped');
    const failed = world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.reason).toContain('tenant entry refused owner with field-name');
    expect(failed?.reason).toContain('[address]');
    expect(JSON.stringify(world.state.records)).not.toContain('x.y@example.invalid');
    expect(ownerCalls(entry)).toHaveLength(1);
  });

  it('waits for the container: not-running is retried, not a permanent stop', async () => {
    const { entry, ports } = rig();
    entry.notRunningFirst = 2;
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('complete');
    expect(ownerCalls(entry)).toHaveLength(3);
    expect(entry.owners.size).toBe(1);
  });

  it('sends no owner for a unit that is not enabled with its secrets and stack', async () => {
    const { entry, inputs, ports } = rig();
    const host = ports.hosts['app-host'];
    await host.run(request('render-host-secrets'));
    await host.run(request('render-compose-file'));
    await expect(host.run(request('create-owner-account'))).rejects.toBeInstanceOf(
      PermanentStepError
    );
    expect(ownerCalls(entry)).toHaveLength(0);
    expect(inputs.reads).not.toContain('owner:create-owner-account');

    const never = rig();
    await expect(
      never.ports.hosts['app-host'].run(request('create-owner-account'))
    ).rejects.toBeInstanceOf(PermanentStepError);
    expect(never.entry.verbs()).toEqual([]);
  });

  it('refuses before sending an owner the host would not accept, naming the field and not its value', async () => {
    const cases: readonly [Partial<OwnerParameters>, string][] = [
      [{ name: '--email' }, 'name'],
      [{ name: 'x'.repeat(65) }, 'name'],
      [{ siteTitle: 'a\nb' }, 'site title'],
      [{ siteTitle: 't'.repeat(121) }, 'site title'],
      [{ siteUrl: 'http://demo.example.invalid' }, 'site address'],
      [{ siteUrl: 'https://Demo.example.invalid/path' }, 'site address'],
      [{ colour: 'c' as 'a' }, 'colour'],
    ];
    for (const [change, field] of cases) {
      const { entry, inputs, ports } = rig();
      const host = ports.hosts['app-host'];
      for (const id of [
        'render-host-secrets',
        'render-compose-file',
        'create-app-host-slot',
      ] as const) {
        await host.run(request(id));
      }
      inputs.ownerParameters = { ...OWNER, ...change };
      await expect(host.run(request('create-owner-account'))).rejects.toThrow(
        new RegExp(`the owner's ${field} is not usable`)
      );
      expect(ownerCalls(entry)).toHaveLength(0);
    }
  });

  it('sends exactly colour, name, site_url and site_title, whatever a provider returns beside them', async () => {
    const { entry, inputs, ports } = rig();
    inputs.ownerExtra = { email: 'owner@example.invalid', extra: 'y' };
    const result = await executeOnboarding(DEMO_APPROVAL.approvalId, ports);
    expect(result.status).toBe('complete');
    expect(Object.keys(ownerCalls(entry)[0]?.payload ?? {}).sort()).toEqual([
      'colour',
      'name',
      'site_title',
      'site_url',
    ]);
    expect(JSON.stringify(ownerCalls(entry))).not.toContain('owner@example.invalid');
  });
});
