import { describe, expect, it } from 'vitest';
import {
  MEDIA_PLACEHOLDER_NAMES,
  RegisterEntryInvalidError,
  STEP_IDS,
  commandHostPorts,
  executeOnboarding,
  planOnboarding,
  type EntryPoint,
  type ExecutePorts,
  type PlannedStep,
  type RegisterEntry,
  type StepId,
} from '../../src/index.js';
import { APPROVAL, ENTRY, World } from '../support/doubles.js';

const DIGEST = `sha256:${'ab'.repeat(32)}`;

/** What `demo-tenant` is in the register: no public name, mail off, s3 media, backups off. */
const PRIVATE: RegisterEntry = {
  ...ENTRY,
  hostnames: [],
  mail: false,
  mediaMode: 's3',
  backups: false,
  imageDigest: DIGEST,
};

const NOT_APPLICABLE: readonly StepId[] = [
  'mint-media-credential',
  'mint-state-credential',
  'push-first-commit',
  'publish-mail-dns',
  'publish-hostnames',
  'enrol-backups',
];

const key = (id: string): string => `${ENTRY.tenantId}/${id}`;

async function planFor(entry: RegisterEntry): Promise<readonly PlannedStep[]> {
  const world = new World();
  world.entry = entry;
  return (await planOnboarding(APPROVAL.approvalId, world.ports())).steps;
}

const PRIVATE_SLOT_GAPS: readonly EntryPoint[] = ['dns', 'edge', 'source-host', 'storage-gateway'];

/** Hosts as a deployment with no program for the named entry points: they refuse at once. */
function portsWithoutPrograms(
  world: World,
  gaps: readonly EntryPoint[] = PRIVATE_SLOT_GAPS
): ExecutePorts {
  const none = commandHostPorts({}, {});
  const ports = world.ports();
  return {
    ...ports,
    hosts: { ...ports.hosts, ...Object.fromEntries(gaps.map((g) => [g, none[g]])) },
  };
}

describe('the plan: a step the register makes not apply', () => {
  it('marks exactly the steps a private, mail-off, s3-media, backups-off tenant does not need', async () => {
    const steps = await planFor(PRIVATE);
    expect(steps.filter((s) => s.notApplicable !== undefined).map((s) => s.id)).toEqual(
      STEP_IDS.filter((id) => NOT_APPLICABLE.includes(id))
    );
    const by = (id: StepId): PlannedStep | undefined => steps.find((s) => s.id === id);
    expect(by('publish-hostnames')?.notApplicable).toBe('no-hostnames');
    expect(by('push-first-commit')?.notApplicable).toBe('no-hostnames');
    expect(by('publish-mail-dns')?.notApplicable).toBe('no-hostnames');
    expect(by('mint-media-credential')?.notApplicable).toBe('s3-media');
    expect(by('mint-state-credential')?.notApplicable).toBe('s3-media');
    expect(by('enrol-backups')?.notApplicable).toBe('backups-off');
  });

  it('plans every step as applicable for a register with hostnames, mail, gateway media and backups', async () => {
    const steps = await planFor(ENTRY);
    expect(steps.filter((s) => s.notApplicable !== undefined)).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    const edge = steps.find((s) => s.id === 'publish-hostnames');
    expect(edge?.inputs['hostnames']).toEqual(ENTRY.hostnames);
    expect(edge?.inputs['notApplicable']).toBeUndefined();
  });

  it('keeps the step in the plan, in its place, with its own digest that names the reason', async () => {
    const applicable = await planFor(ENTRY);
    const skipped = await planFor(PRIVATE);
    expect(skipped.map((s) => s.id)).toEqual(applicable.map((s) => s.id));
    for (const id of NOT_APPLICABLE) {
      const a = applicable.find((s) => s.id === id);
      const n = skipped.find((s) => s.id === id);
      expect(n?.inputDigest).not.toBe(a?.inputDigest);
      expect(typeof n?.inputs['notApplicable']).toBe('string');
      expect(n?.inputs['notApplicable']).toBe(n?.notApplicable);
    }
  });

  it('turns only the mail step off when mail is off and the tenant has a public name', async () => {
    const steps = await planFor({ ...ENTRY, mail: false });
    expect(
      steps.filter((s) => s.notApplicable !== undefined).map((s) => [s.id, s.notApplicable])
    ).toEqual([['publish-mail-dns', 'mail-off']]);
  });

  it('names the placeholder secrets in the media step and carries no value', async () => {
    const steps = await planFor(PRIVATE);
    const media = steps.find((s) => s.id === 'mint-media-credential');
    expect(media?.inputs['placeholders']).toEqual([...MEDIA_PLACEHOLDER_NAMES]);
    expect(JSON.stringify(steps)).not.toContain('PLACEHOLDER-');
  });

  it('carries the register image digest into the first deploy, and only that', async () => {
    const steps = await planFor(PRIVATE);
    expect(steps.find((s) => s.id === 'first-deploy')?.inputs).toEqual({
      slot: ENTRY.appHostSlot,
      port: ENTRY.appHostPort,
      uid: ENTRY.appHostUid,
      imageDigest: DIGEST,
    });
  });

  it('refuses a malformed value in a field it adds, and a malformed hostname in a non-empty list', async () => {
    const bad = {
      ...ENTRY,
      hostnames: ['NOT A HOST'],
      mediaMode: 'gcs',
      imageDigest: 'latest',
      mail: 'no',
    } as unknown as RegisterEntry;
    const err = await planFor(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegisterEntryInvalidError);
    expect((err as RegisterEntryInvalidError).fields).toEqual([
      'hostnames',
      'mail',
      'mediaMode',
      'imageDigest',
    ]);
  });
});

describe('the run: not-applicable steps are recorded, never run and never failed', () => {
  it('runs a private tenant with no program for dns, edge, source or the gateway, recording the six steps', async () => {
    const world = new World();
    world.entry = PRIVATE;
    const result = await executeOnboarding(APPROVAL.approvalId, portsWithoutPrograms(world));

    expect(result.status).toBe('complete');
    expect([...result.notApplicable].sort()).toEqual(NOT_APPLICABLE.map(key).sort());
    expect(result.ran).toHaveLength(STEP_IDS.length - NOT_APPLICABLE.length);
    const recorded = world.state.records.filter((r) => r.event === 'not-applicable');
    expect(recorded.map((r) => r.key).sort()).toEqual(NOT_APPLICABLE.map(key).sort());
    expect(recorded.every((r) => typeof r.reason === 'string' && r.inputDigest !== undefined)).toBe(
      true
    );
    // Not one of those steps reached a host, or was even started.
    const called = new Set(world.calls.map((c) => c.request.id));
    for (const id of NOT_APPLICABLE) expect(called.has(id)).toBe(false);
    expect(
      world.state.records.filter(
        (r) => r.event === 'started' && NOT_APPLICABLE.map(key).includes(r.key ?? '')
      )
    ).toEqual([]);
    expect(world.events.filter((e) => e.type === 'step-not-applicable')).toHaveLength(
      NOT_APPLICABLE.length
    );
    expect(world.state.records.at(-1)?.event).toBe('run-complete');
  });

  // The sabotage pair: the same missing programs, a register that needs them.
  it('fails at the DNS step for a register with hostnames and no DNS program', async () => {
    const world = new World();
    world.entry = { ...PRIVATE, hostnames: ['host-one.example.invalid'], mail: true };
    const result = await executeOnboarding(
      APPROVAL.approvalId,
      portsWithoutPrograms(world, ['dns'])
    );

    expect(result.status).toBe('stopped');
    expect(result.stoppedAt).toEqual({ key: key('publish-mail-dns'), reason: 'step-failed' });
    const failed = world.state.records.find((r) => r.event === 'step-failed');
    expect(failed?.reason).toContain('no host entry point is configured for dns');
    expect(result.notApplicable).not.toContain(key('publish-mail-dns'));
  });

  it('still plans and runs the hostname steps for a register with hostnames', async () => {
    const world = new World();
    const result = await executeOnboarding(APPROVAL.approvalId, world.ports());
    expect(result.notApplicable).toEqual([]);
    const called = world.calls.map((c) => c.request.id);
    for (const id of ['publish-hostnames', 'publish-mail-dns', 'push-first-commit'] as const) {
      expect(called).toContain(id);
    }
  });

  it('skips a recorded not-applicable step on the next call, under the same digest', async () => {
    const world = new World();
    world.entry = PRIVATE;
    await executeOnboarding(APPROVAL.approvalId, portsWithoutPrograms(world));
    const calls = world.calls.length;
    const again = await executeOnboarding(APPROVAL.approvalId, portsWithoutPrograms(world));
    expect(again.status).toBe('complete');
    expect(again.ran).toEqual([]);
    expect(again.notApplicable).toEqual([]);
    expect(again.skipped).toHaveLength(STEP_IDS.length);
    expect(world.calls).toHaveLength(calls);
  });

  it('refuses to carry on when a recorded not-applicable step now applies', async () => {
    const world = new World();
    world.entry = PRIVATE;
    await executeOnboarding(APPROVAL.approvalId, portsWithoutPrograms(world));
    world.entry = { ...PRIVATE, hostnames: ['host-one.example.invalid'] };
    const result = await executeOnboarding(APPROVAL.approvalId, portsWithoutPrograms(world));
    expect(result.status).toBe('stopped');
    expect(result.stoppedAt?.reason).toBe('input-changed');
    expect(world.state.records.some((r) => r.event === 'digest-mismatch')).toBe(true);
  });

  it('does not let a failed step hide behind a not-applicable one', async () => {
    const world = new World();
    world.entry = PRIVATE;
    world.permanent.add(key('create-app-host-slot'));
    const result = await executeOnboarding(APPROVAL.approvalId, portsWithoutPrograms(world));
    expect(result.stoppedAt).toEqual({ key: key('create-app-host-slot'), reason: 'step-failed' });
    expect(world.calls.map((c) => c.request.id)).not.toContain('first-deploy');
  });
});
