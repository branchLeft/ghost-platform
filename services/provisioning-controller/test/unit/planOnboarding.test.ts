import { describe, expect, it } from 'vitest';
import {
  ApprovalRequiredError,
  ApprovalScopeError,
  RegisterEntryInvalidError,
  RegisterEntryMissingError,
  STEP_IDS,
  digestOf,
  planOnboarding,
  type ApprovalScope,
  type PlanPorts,
  type RecordedApproval,
  type RegisterEntry,
} from '../../src/index.js';

const ENTRY: RegisterEntry = {
  tenantId: 'TENANT_ID_PLACEHOLDER',
  mediaFolder: 'MEDIA_FOLDER_PLACEHOLDER',
  mediaBucket: 'BUCKET_PLACEHOLDER',
  appHostSlot: 'SLOT_PLACEHOLDER',
  appHostPort: 20001,
  appHostUid: 20001,
  hostnames: ['host-one.example.invalid', 'host-two.example.invalid'],
};

const APPROVAL: RecordedApproval = {
  approvalId: 'APPROVAL_ID_PLACEHOLDER',
  tenantId: ENTRY.tenantId,
  approvedAt: '2026-01-01T00:00:00Z',
  scopes: ['setup', 'web-address', 'first-deploy'],
};

function doubles(opts: {
  approval?: RecordedApproval | undefined;
  entry?: RegisterEntry | undefined;
}): PlanPorts & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    approvals: { find: async () => opts.approval },
    register: {
      read: async (tenantId) => {
        reads.push(tenantId);
        return opts.entry;
      },
    },
  };
}

describe('planOnboarding', () => {
  it('is refused with no recorded approval, and reads nothing else', async () => {
    const ports = doubles({ approval: undefined, entry: ENTRY });
    await expect(planOnboarding('APPROVAL_ID_PLACEHOLDER', ports)).rejects.toBeInstanceOf(
      ApprovalRequiredError
    );
    expect(ports.reads).toEqual([]);
  });

  it('is refused when the approval leaves out any part of the one approval', async () => {
    const scopes: ApprovalScope[] = ['setup'];
    const ports = doubles({ approval: { ...APPROVAL, scopes }, entry: ENTRY });
    const err = await planOnboarding(APPROVAL.approvalId, ports).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalScopeError);
    expect((err as ApprovalScopeError).missing).toEqual(['web-address', 'first-deploy']);
    expect(ports.reads).toEqual([]);
  });

  it('builds the whole plan from the approval and the register and nothing else', async () => {
    const ports = doubles({ approval: APPROVAL, entry: ENTRY });
    const plan = await planOnboarding(APPROVAL.approvalId, ports);

    expect(ports.reads).toEqual([ENTRY.tenantId]);
    expect(plan.approvalId).toBe(APPROVAL.approvalId);
    expect(plan.tenantId).toBe(ENTRY.tenantId);
    expect(plan.steps.map((s) => s.id)).toEqual([...STEP_IDS]);
    expect(plan.steps.map((s) => s.order)).toEqual(STEP_IDS.map((_, i) => i + 1));

    const deploy = plan.steps.find((s) => s.id === 'first-deploy');
    expect(deploy?.inputs).toEqual({ slot: 'SLOT_PLACEHOLDER', port: 20001, uid: 20001 });
    const media = plan.steps.find((s) => s.id === 'mint-media-credential');
    expect(media?.inputs).toEqual({
      bucket: 'BUCKET_PLACEHOLDER',
      prefix: 'MEDIA_FOLDER_PLACEHOLDER',
    });
    const edge = plan.steps.find((s) => s.id === 'publish-hostnames');
    expect(edge?.inputs['hostnames']).toEqual(ENTRY.hostnames);
  });

  it('keys each step uniquely and stably so a later run can record per-step state', async () => {
    const ports = doubles({ approval: APPROVAL, entry: ENTRY });
    const a = await planOnboarding(APPROVAL.approvalId, ports);
    const b = await planOnboarding(APPROVAL.approvalId, ports);
    expect(new Set(a.steps.map((s) => s.key)).size).toBe(a.steps.length);
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    expect(a.steps[0]?.key).toBe('TENANT_ID_PLACEHOLDER/confirm-register-assignment');
  });

  it('orders every step after the steps it depends on', async () => {
    const plan = await planOnboarding(
      APPROVAL.approvalId,
      doubles({ approval: APPROVAL, entry: ENTRY })
    );
    const position = new Map(plan.steps.map((s) => [s.id, s.order]));
    for (const step of plan.steps) {
      for (const dep of step.dependsOn) {
        expect(position.get(dep)).toBeLessThan(step.order);
      }
    }
  });

  it('carries only names of secrets, never a value', async () => {
    const plan = await planOnboarding(
      APPROVAL.approvalId,
      doubles({ approval: APPROVAL, entry: ENTRY })
    );
    for (const step of plan.steps) {
      expect(Object.keys(step.inputs).some((k) => /password|token|key$/i.test(k))).toBe(false);
    }
  });

  it('changes a step digest when the register changes', async () => {
    const first = await planOnboarding(
      APPROVAL.approvalId,
      doubles({ approval: APPROVAL, entry: ENTRY })
    );
    const moved = await planOnboarding(
      APPROVAL.approvalId,
      doubles({ approval: APPROVAL, entry: { ...ENTRY, appHostPort: 20002 } })
    );
    const pick = (p: typeof first) => p.steps.find((s) => s.id === 'first-deploy')?.inputDigest;
    expect(pick(first)).not.toBe(pick(moved));
    expect(digestOf({ b: 1, a: 2 })).toBe(digestOf({ a: 2, b: 1 }));
  });

  it('refuses a tenant with no register entry, or one that answers for another tenant', async () => {
    await expect(
      planOnboarding(APPROVAL.approvalId, doubles({ approval: APPROVAL, entry: undefined }))
    ).rejects.toBeInstanceOf(RegisterEntryMissingError);
    await expect(
      planOnboarding(
        APPROVAL.approvalId,
        doubles({ approval: APPROVAL, entry: { ...ENTRY, tenantId: 'OTHER_ID_PLACEHOLDER' } })
      )
    ).rejects.toBeInstanceOf(RegisterEntryMissingError);
  });

  it('names every unusable register field rather than guessing', async () => {
    const entry: RegisterEntry = {
      ...ENTRY,
      mediaFolder: '',
      mediaBucket: 'has space',
      appHostSlot: '',
      appHostPort: 80,
      appHostUid: 0,
      hostnames: ['NOT A HOST'],
    };
    const err = await planOnboarding(
      APPROVAL.approvalId,
      doubles({ approval: APPROVAL, entry })
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegisterEntryInvalidError);
    expect((err as RegisterEntryInvalidError).fields).toEqual([
      'mediaFolder',
      'mediaBucket',
      'appHostSlot',
      'appHostPort',
      'appHostUid',
      'hostnames',
    ]);
  });

  it('refuses an empty hostname list', async () => {
    const err = await planOnboarding(
      APPROVAL.approvalId,
      doubles({ approval: APPROVAL, entry: { ...ENTRY, hostnames: [] } })
    ).catch((e: unknown) => e);
    expect((err as RegisterEntryInvalidError).fields).toEqual(['hostnames']);
  });
});
