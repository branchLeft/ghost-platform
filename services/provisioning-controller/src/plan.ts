import { createHash } from 'node:crypto';
import type { ApprovalScope, RegisterEntry } from './ports.js';

/** Where a step is carried out; each is a narrow entry point, never a shell. */
export const ENTRY_POINTS = [
  'controller',
  'db-host',
  'app-host',
  'storage-gateway',
  'source-host',
  'edge',
  'dns',
] as const;
export type EntryPoint = (typeof ENTRY_POINTS)[number];

export const STEP_IDS = [
  'confirm-register-assignment',
  'escrow-stack-passphrase',
  'create-database',
  'mint-media-credential',
  'mint-state-credential',
  'render-host-secrets',
  'render-compose-file',
  'register-host-keys',
  'create-app-host-slot',
  'push-first-commit',
  'publish-mail-dns',
  'first-deploy',
  'create-owner-account',
  'publish-hostnames',
  'enrol-backups',
] as const;
export type StepId = (typeof STEP_IDS)[number];

/**
 * Why a step has nothing to do for this tenant. Each is a fact the register states: an empty
 * hostname list, mail off, s3 media, backups off. A step with one of these is recorded complete as
 * not applicable, never run and never failed for want of a program.
 */
export const NOT_APPLICABLE_REASONS = [
  'no-hostnames',
  'mail-off',
  's3-media',
  'backups-off',
] as const;
export type NotApplicableReason = (typeof NOT_APPLICABLE_REASONS)[number];

/**
 * The names of the secrets the controller fills with marked placeholder values for an s3 media
 * tenant (the bucket key pair, as the secrets template names them). Names only: the values are
 * made by `GeneratedTenantEntryInputs`, the one generator, when the secrets are rendered.
 */
export const MEDIA_PLACEHOLDER_NAMES = [
  'GHOST_S3_ACCESS_KEY_ID',
  'GHOST_S3_SECRET_ACCESS_KEY',
] as const;

/** Every input is a register-derived value or a name of a secret; no secret value is ever carried. */
export type StepInputs = Readonly<Record<string, string | number | readonly string[]>>;

export interface PlannedStep {
  /** Stable across re-approval and across restarts: the key part 2 records state under. */
  readonly key: string;
  readonly id: StepId;
  readonly order: number;
  readonly entryPoint: EntryPoint;
  readonly scope: ApprovalScope;
  readonly dependsOn: readonly StepId[];
  readonly inputs: StepInputs;
  /**
   * Set when the register makes the step not apply. The reason is also one of the `inputs`, so the
   * digest changes when a step turns applicable or not and a recorded step is never re-planned
   * quietly.
   */
  readonly notApplicable?: NotApplicableReason;
  /** Hash of the inputs: a recorded step whose digest differs was planned from a changed register. */
  readonly inputDigest: string;
}

export interface OnboardingPlan {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly steps: readonly PlannedStep[];
}

interface StepSpec {
  readonly id: StepId;
  readonly entryPoint: EntryPoint;
  readonly scope: ApprovalScope;
  readonly dependsOn: readonly StepId[];
  readonly inputs: (e: RegisterEntry) => StepInputs;
  /** The register fact that makes this step not apply, or undefined when it does. */
  readonly notApplicable?: (e: RegisterEntry) => NotApplicableReason | undefined;
  /** Secret names filled with placeholders when the step is not applicable, named in its inputs. */
  readonly placeholders?: readonly string[];
}

const noHostnames = (e: RegisterEntry): NotApplicableReason | undefined =>
  e.hostnames.length === 0 ? 'no-hostnames' : undefined;
const s3Media = (e: RegisterEntry): NotApplicableReason | undefined =>
  e.mediaMode === 's3' ? 's3-media' : undefined;

const slotOf = (e: RegisterEntry): StepInputs => ({
  slot: e.appHostSlot,
  port: e.appHostPort,
  uid: e.appHostUid,
});

/** The order is the dependency order; page 21 of the design lists the steps. */
const SPECS: readonly StepSpec[] = [
  {
    id: 'confirm-register-assignment',
    entryPoint: 'controller',
    scope: 'setup',
    dependsOn: [],
    inputs: (e) => ({ ...slotOf(e), bucket: e.mediaBucket, folder: e.mediaFolder }),
  },
  {
    id: 'escrow-stack-passphrase',
    entryPoint: 'controller',
    scope: 'setup',
    dependsOn: ['confirm-register-assignment'],
    inputs: (e) => ({ secretName: `STACK_PASSPHRASE_${e.appHostSlot}` }),
  },
  {
    id: 'create-database',
    entryPoint: 'db-host',
    scope: 'setup',
    dependsOn: ['confirm-register-assignment'],
    inputs: (e) => ({ slot: e.appHostSlot, deliverSecretTo: `app-host:${e.appHostSlot}` }),
  },
  {
    id: 'mint-media-credential',
    entryPoint: 'storage-gateway',
    scope: 'setup',
    dependsOn: ['confirm-register-assignment'],
    inputs: (e) => ({ bucket: e.mediaBucket, prefix: e.mediaFolder }),
    notApplicable: s3Media,
    placeholders: MEDIA_PLACEHOLDER_NAMES,
  },
  {
    // The tenant's own state credential, from the gateway's state instance,
    // confined to its own prefix in the state bucket. The bucket is not an
    // input: the state instance names the one bucket it serves, so a plan
    // cannot steer a credential at another. Nothing here is a secret value.
    id: 'mint-state-credential',
    entryPoint: 'storage-gateway',
    scope: 'setup',
    dependsOn: ['confirm-register-assignment'],
    inputs: (e) => ({ prefix: e.stateFolder }),
    notApplicable: s3Media,
  },
  {
    id: 'render-host-secrets',
    entryPoint: 'app-host',
    scope: 'setup',
    dependsOn: ['create-database', 'mint-media-credential', 'escrow-stack-passphrase'],
    inputs: slotOf,
  },
  {
    // The tenant's compose file and first image pin reach the host only through the host's
    // `stack` entry point, which refuses a stack its judge refuses. It comes after the secrets
    // file, which the judge reads, and before the unit is enabled and the slot is created.
    id: 'render-compose-file',
    entryPoint: 'app-host',
    scope: 'setup',
    dependsOn: ['render-host-secrets'],
    inputs: slotOf,
  },
  {
    id: 'register-host-keys',
    entryPoint: 'controller',
    scope: 'setup',
    dependsOn: ['confirm-register-assignment'],
    inputs: (e) => ({ slot: e.appHostSlot }),
  },
  {
    id: 'create-app-host-slot',
    entryPoint: 'app-host',
    scope: 'setup',
    dependsOn: ['render-compose-file', 'register-host-keys'],
    inputs: slotOf,
  },
  {
    id: 'push-first-commit',
    entryPoint: 'source-host',
    scope: 'setup',
    dependsOn: ['create-app-host-slot'],
    inputs: (e) => ({ slot: e.appHostSlot, hostnames: e.hostnames }),
    notApplicable: noHostnames,
  },
  {
    id: 'publish-mail-dns',
    entryPoint: 'dns',
    scope: 'web-address',
    dependsOn: ['create-app-host-slot'],
    inputs: (e) => ({ hostnames: e.hostnames }),
    notApplicable: (e) => noHostnames(e) ?? (e.mail === false ? 'mail-off' : undefined),
  },
  {
    id: 'first-deploy',
    entryPoint: 'app-host',
    scope: 'first-deploy',
    dependsOn: ['push-first-commit', 'publish-mail-dns'],
    // The image comes from the register and nowhere else; the adapter refuses a deploy with none.
    inputs: (e) => ({
      ...slotOf(e),
      ...(e.imageDigest !== undefined && { imageDigest: e.imageDigest }),
    }),
  },
  {
    id: 'create-owner-account',
    entryPoint: 'app-host',
    scope: 'first-deploy',
    dependsOn: ['first-deploy'],
    inputs: (e) => ({ slot: e.appHostSlot, secretName: `OWNER_SETUP_${e.appHostSlot}` }),
  },
  {
    // The edge is what makes the site reachable, and a Ghost with no owner is
    // claimed by whoever reaches its setup route first. So this waits for the
    // owner account itself, not only for the deploy: nothing may publish a
    // hostname until `create-owner-account` is recorded complete.
    id: 'publish-hostnames',
    entryPoint: 'edge',
    scope: 'web-address',
    dependsOn: ['create-app-host-slot', 'create-owner-account'],
    inputs: (e) => ({ hostnames: e.hostnames, port: e.appHostPort, slot: e.appHostSlot }),
    notApplicable: noHostnames,
  },
  {
    id: 'enrol-backups',
    entryPoint: 'controller',
    scope: 'first-deploy',
    dependsOn: ['first-deploy'],
    inputs: (e) => ({ slot: e.appHostSlot, escrowName: `BACKUP_IDENTITY_${e.appHostSlot}` }),
    notApplicable: (e) => (e.backups === false ? 'backups-off' : undefined),
  },
];

export const digestOf = (inputs: StepInputs): string => {
  const sorted = Object.keys(inputs)
    .sort()
    .map((k) => [k, inputs[k]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
};

export function buildSteps(entry: RegisterEntry): PlannedStep[] {
  return SPECS.map((spec, index) => {
    const reason = spec.notApplicable?.(entry);
    const inputs: StepInputs = {
      ...spec.inputs(entry),
      ...(reason !== undefined && { notApplicable: reason }),
      ...(reason !== undefined &&
        spec.placeholders !== undefined && { placeholders: spec.placeholders }),
    };
    return {
      key: `${entry.tenantId}/${spec.id}`,
      id: spec.id,
      order: index + 1,
      entryPoint: spec.entryPoint,
      scope: spec.scope,
      dependsOn: spec.dependsOn,
      inputs,
      ...(reason !== undefined && { notApplicable: reason }),
      inputDigest: digestOf(inputs),
    };
  });
}
