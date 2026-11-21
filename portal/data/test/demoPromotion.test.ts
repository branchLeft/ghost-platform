import { describe, expect, it } from 'vitest';
import { ForbiddenTransitionError, type DemoState } from '../src/demoLifecycle.js';
import { TermsNotAcceptedError, type DocumentView } from '../src/documents.js';
import {
  PROMOTION_TARGET_FIELDS,
  PromotionRefusedError,
  PromotionTargetMissingError,
  promoteDemo,
  type ContentVerification,
  type GateVerdict,
  type PromotionEffects,
  type PromotionRequest,
  type PromotionTargets,
} from '../src/demoPromotion.js';

const DEMO = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = new Date('2026-11-11T00:00:00Z');
const MUTATING = ['transition', 'commitSwap', 'takeFirstDump', 'abortPromotion', 'retireHostname'];

const TARGETS: PromotionTargets = Object.fromEntries(
  PROMOTION_TARGET_FIELDS.map((field) => [field, `VALUE_${field}`])
);
const SLUG = 'SLUG_VALUE';
const COMPLETE_CONTENT: ContentVerification = {
  postPresent: true,
  memberPresent: true,
  imagePresent: true,
  mediaFilePresent: true,
  filePresent: true,
  mediaStored: 2,
  mediaListed: 2,
};

interface Fake {
  effects: PromotionEffects;
  calls: string[];
}

interface Behaviour {
  drained?: boolean | (() => boolean);
  gate?: GateVerdict;
  /** Document kinds the owner has not accepted; an unreadable answer is an `Error` instead. */
  pending?: readonly string[] | Error;
  content?: ContentVerification;
  failing?: string[];
  dumpReference?: string;
}

function fake(behaviour: Behaviour = {}): Fake {
  const calls: string[] = [];
  const fails = (name: string): boolean => behaviour.failing?.includes(name) ?? false;
  const run = async <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    if (fails(name)) throw new Error('INJECTED_FAILURE');
    return value;
  };
  const drained = (): boolean => {
    const set = behaviour.drained ?? true;
    return typeof set === 'function' ? set() : set;
  };
  const effects: PromotionEffects = {
    isDrained: () => run('isDrained', drained()),
    gateVerdict: () => run('gateVerdict', behaviour.gate ?? 'PROMOTE'),
    assertDocumentsAccepted: async () => {
      calls.push('assertDocumentsAccepted');
      const { pending = [] } = behaviour;
      if (pending instanceof Error) throw pending;
      if (pending.length > 0) {
        throw new TermsNotAcceptedError(
          pending.map((kind) => ({ kind, version: 2 }) as unknown as DocumentView)
        );
      }
    },
    transition: (_id, to) => run(`transition:${to}`, undefined),
    commitSwap: () => run('commitSwap', undefined),
    rollbackSwap: () => run('rollbackSwap', undefined),
    verifyContent: () => run('verifyContent', behaviour.content ?? COMPLETE_CONTENT),
    takeFirstDump: () =>
      run('takeFirstDump', { reference: behaviour.dumpReference ?? 'DUMP_REF', takenAt: NOW }),
    abortPromotion: (_id, returnTo) => run(`abortPromotion:${returnTo}`, undefined),
    retireHostname: () => run('retireHostname', undefined),
  };
  return { effects, calls };
}

function request(overrides: Partial<PromotionRequest> = {}): PromotionRequest {
  return {
    demoId: DEMO,
    tenantSlug: SLUG,
    position: { state: 'LIVE', origin: null },
    approval: { reference: 'APPROVAL_REF', recordedAt: NOW },
    consent: { reference: 'CONSENT_REF', recordedAt: NOW },
    exportDone: { reference: 'EXPORT_REF', recordedAt: NOW, archiveReference: 'ARCHIVE_REF' },
    targets: TARGETS,
    ...overrides,
  };
}

function mutations(calls: string[]): string[] {
  return calls.filter((call) =>
    MUTATING.some((name) => call === name || call.startsWith(`${name}:`))
  );
}

describe('promoteDemo, the whole path', () => {
  it('runs the effects in order and reports the promotion with its dump', async () => {
    const { effects, calls } = fake();
    const outcome = await promoteDemo(request(), effects);
    expect(calls).toEqual([
      'assertDocumentsAccepted',
      'isDrained',
      'gateVerdict',
      'transition:PROMOTING',
      'commitSwap',
      'verifyContent',
      'takeFirstDump',
      'isDrained',
      'transition:PROMOTED',
      'retireHostname',
    ]);
    expect(outcome).toEqual({
      status: 'promoted',
      dump: { reference: 'DUMP_REF', takenAt: NOW },
      hostnameRetired: true,
    });
  });

  it.each(['LIVE', 'EXTENDED', 'EXPIRING'] as DemoState[])('starts from %s', async (state) => {
    const { effects } = fake();
    const outcome = await promoteDemo(request({ position: { state, origin: null } }), effects);
    expect(outcome.status).toBe('promoted');
  });

  it('reports the promotion complete when only retiring the hostname fails', async () => {
    const { effects } = fake({ failing: ['retireHostname'] });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({ status: 'promoted', hostnameRetired: false });
  });
});

describe('promoteDemo, preconditions are enforced before any write', () => {
  it('refuses a demo whose owner has not accepted the current documents, naming them', async () => {
    const { effects, calls } = fake({ pending: ['terms', 'dpa'] });
    const refused = promoteDemo(request(), effects);
    await expect(refused).rejects.toBeInstanceOf(PromotionRefusedError);
    await expect(refused).rejects.toMatchObject({ precondition: 'documents' });
    await expect(refused).rejects.toThrow('not accepted: terms v2, dpa v2');
    expect(calls).toContain('assertDocumentsAccepted');
    expect(mutations(calls)).toEqual([]);
  });

  it('refuses, and writes nothing, when acceptance cannot be read', async () => {
    const { effects, calls } = fake({ pending: new Error('DB_DOWN') });
    await expect(promoteDemo(request(), effects)).rejects.toMatchObject({
      precondition: 'documents',
    });
    expect(mutations(calls)).toEqual([]);
  });

  it('goes through for an owner who has accepted every current document', async () => {
    const { effects, calls } = fake({ pending: [] });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome.status).toBe('promoted');
    expect(calls[0]).toBe('assertDocumentsAccepted');
    expect(mutations(calls)).toContain('transition:PROMOTING');
  });

  it('refuses a gate that does not say PROMOTE', async () => {
    for (const verdict of ['WAIT', 'ABANDON'] as GateVerdict[]) {
      const { effects, calls } = fake({ gate: verdict });
      await expect(promoteDemo(request(), effects)).rejects.toMatchObject({ precondition: 'gate' });
      expect(mutations(calls)).toEqual([]);
    }
  });

  it('refuses when the export is not done', async () => {
    const { effects, calls } = fake();
    await expect(promoteDemo(request({ exportDone: null }), effects)).rejects.toMatchObject({
      precondition: 'export',
    });
    expect(mutations(calls)).toEqual([]);
  });

  it('refuses an export with no archive', async () => {
    const { effects, calls } = fake();
    const exportDone = { reference: 'EXPORT_REF', recordedAt: NOW, archiveReference: '' };
    await expect(promoteDemo(request({ exportDone }), effects)).rejects.toMatchObject({
      precondition: 'export',
    });
    expect(mutations(calls)).toEqual([]);
  });

  it('refuses when the drain flag is not set', async () => {
    const { effects, calls } = fake({ drained: false });
    await expect(promoteDemo(request(), effects)).rejects.toMatchObject({ precondition: 'drain' });
    expect(mutations(calls)).toEqual([]);
  });

  it('refuses without a recorded approval', async () => {
    const { effects, calls } = fake();
    await expect(promoteDemo(request({ approval: null }), effects)).rejects.toMatchObject({
      precondition: 'approval',
    });
    expect(calls).toEqual([]);
  });

  it('refuses without a recorded consent', async () => {
    const { effects, calls } = fake();
    await expect(promoteDemo(request({ consent: null }), effects)).rejects.toMatchObject({
      precondition: 'consent',
    });
    expect(calls).toEqual([]);
  });

  it.each(PROMOTION_TARGET_FIELDS)(
    'refuses a promotion with %s left out, by name',
    async (field) => {
      const { effects, calls } = fake();
      const { [field]: _left, ...rest } = TARGETS;
      const refused = promoteDemo(request({ targets: rest }), effects);
      await expect(refused).rejects.toBeInstanceOf(PromotionTargetMissingError);
      await expect(refused).rejects.toThrow(field);
      expect(calls).toEqual([]);
    }
  );

  it('names every target left out, and takes a false or a zero as an answer', async () => {
    const { effects } = fake();
    const targets = {
      ...TARGETS,
      mediaResize: false,
      mailCeiling: 0,
      mailEnabled: undefined,
      limits: null,
    };
    await expect(promoteDemo(request({ targets }), effects)).rejects.toMatchObject({
      fields: ['limits', 'mailEnabled'],
    });
  });

  it.each([
    'VERIFIED',
    'WAITING',
    'CLAIMED',
    'PROVISIONING',
    'PROMOTING',
    'PROMOTED',
    'KILLED',
    'PURGED',
  ] as DemoState[])('refuses from %s', async (state) => {
    const { effects, calls } = fake();
    await expect(
      promoteDemo(request({ position: { state, origin: 'LIVE' } }), effects)
    ).rejects.toBeInstanceOf(ForbiddenTransitionError);
    expect(calls).toEqual([]);
  });

  it('is a PromotionRefusedError that carries no value of the request', async () => {
    const { effects } = fake({ gate: 'ABANDON' });
    const refused = await promoteDemo(request(), effects).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PromotionRefusedError);
    expect(String((refused as Error).message)).not.toContain('VALUE_');
  });
});

describe('promoteDemo, the gateway folder and the tenant-owned settings', () => {
  it('names the gateway endpoint, the opaque folder and the media address as targets', () => {
    expect(PROMOTION_TARGET_FIELDS).toEqual(
      expect.arrayContaining(['mediaEndpoint', 'mediaFolder', 'mediaAddress'])
    );
    expect(PROMOTION_TARGET_FIELDS).not.toContain('mediaRegion');
  });

  it('names every tenant-owned setting the import would otherwise overwrite', () => {
    expect(PROMOTION_TARGET_FIELDS).toEqual(
      expect.arrayContaining(['codeInjection', 'accentColour', 'locale', 'timezone'])
    );
  });

  it('refuses a folder that is the tenant slug, by name, before any write', async () => {
    const { effects, calls } = fake();
    const targets = { ...TARGETS, mediaFolder: SLUG };
    const refused = promoteDemo(request({ targets }), effects);
    await expect(refused).rejects.toBeInstanceOf(PromotionRefusedError);
    await expect(refused).rejects.toThrow('mediaFolder');
    await expect(refused).rejects.toMatchObject({ precondition: 'targets' });
    expect(calls).toEqual([]);
  });

  it('accepts a folder that differs from the slug', async () => {
    const { effects } = fake();
    const targets = { ...TARGETS, mediaFolder: 'OPAQUE_PREFIX' };
    const outcome = await promoteDemo(request({ targets }), effects);
    expect(outcome.status).toBe('promoted');
  });

  it('is incomplete when the content check sees a media count that does not match the list', async () => {
    const content = { ...COMPLETE_CONTENT, mediaStored: 0, mediaListed: 1 };
    const { effects, calls } = fake({ content });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({
      status: 'incomplete',
      failedStep: 'content',
      swapRolledBack: true,
    });
    expect(calls).not.toContain('takeFirstDump');
  });
});

describe('promoteDemo, a failure after PROMOTING is incomplete, never done', () => {
  it('reports an incomplete promotion when the first dump fails, and never PROMOTED', async () => {
    const { effects, calls } = fake({ failing: ['takeFirstDump'] });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toEqual({
      status: 'incomplete',
      failedStep: 'dump',
      reason: 'Error',
      returnedTo: 'LIVE',
      swapRolledBack: true,
    });
    expect(calls).not.toContain('transition:PROMOTED');
    expect(calls).not.toContain('retireHostname');
    expect(calls.slice(-2)).toEqual(['rollbackSwap', 'abortPromotion:LIVE']);
  });

  it('treats a dump with no reference as no dump', async () => {
    const { effects, calls } = fake({ dumpReference: '' });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({ status: 'incomplete', failedStep: 'dump', returnedTo: 'LIVE' });
    expect(calls).not.toContain('transition:PROMOTED');
  });

  it.each([
    { ...COMPLETE_CONTENT, postPresent: false },
    { ...COMPLETE_CONTENT, memberPresent: false },
    { ...COMPLETE_CONTENT, imagePresent: false },
    { ...COMPLETE_CONTENT, mediaFilePresent: false },
    { ...COMPLETE_CONTENT, filePresent: false },
    { ...COMPLETE_CONTENT, mediaStored: 1, mediaListed: 2 },
    { ...COMPLETE_CONTENT, mediaStored: 3, mediaListed: 2 },
  ])('is incomplete when the imported content lacks something: %o', async (content) => {
    const { effects, calls } = fake({ content });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({ status: 'incomplete', failedStep: 'content' });
    expect(calls).not.toContain('takeFirstDump');
    expect(calls).not.toContain('transition:PROMOTED');
  });

  it('returns an extended demo to EXTENDED, not LIVE', async () => {
    const { effects } = fake({ failing: ['takeFirstDump'] });
    const outcome = await promoteDemo(
      request({ position: { state: 'EXTENDED', origin: null } }),
      effects
    );
    expect(outcome).toMatchObject({ status: 'incomplete', returnedTo: 'EXTENDED' });
  });

  it('puts nothing back when the swap itself did not commit', async () => {
    const { effects, calls } = fake({ failing: ['commitSwap'] });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toEqual({
      status: 'incomplete',
      failedStep: 'swap',
      reason: 'Error',
      returnedTo: 'LIVE',
      swapRolledBack: false,
    });
    expect(calls).not.toContain('rollbackSwap');
  });

  it('is incomplete when the drain flag is lifted before the promotion finishes', async () => {
    let reads = 0;
    const { effects, calls } = fake({ drained: () => ++reads === 1 });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({
      status: 'incomplete',
      failedStep: 'drain',
      swapRolledBack: true,
    });
    expect(calls).not.toContain('transition:PROMOTED');
  });

  it('is incomplete when recording PROMOTED fails', async () => {
    const { effects, calls } = fake({ failing: ['transition:PROMOTED'] });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({
      status: 'incomplete',
      failedStep: 'finish',
      returnedTo: 'LIVE',
    });
    expect(calls).not.toContain('retireHostname');
  });

  it('stays PROMOTING when the swap cannot be put back, so nothing is purged under it', async () => {
    const { effects, calls } = fake({ failing: ['takeFirstDump', 'rollbackSwap'] });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toEqual({
      status: 'incomplete',
      failedStep: 'dump',
      reason: 'Error',
      returnedTo: null,
      swapRolledBack: false,
    });
    expect(calls.some((call) => call.startsWith('abortPromotion'))).toBe(false);
  });

  it('says it is still PROMOTING when the abort cannot be recorded', async () => {
    const { effects } = fake({ failing: ['takeFirstDump', 'abortPromotion:LIVE'] });
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({ status: 'incomplete', returnedTo: null, swapRolledBack: true });
  });

  it('reports a thrown non-Error without leaking it', async () => {
    const { effects } = fake();
    effects.takeFirstDump = () => Promise.reject('SECRET_TEXT');
    const outcome = await promoteDemo(request(), effects);
    expect(outcome).toMatchObject({ status: 'incomplete', reason: 'unknown failure' });
  });
});
