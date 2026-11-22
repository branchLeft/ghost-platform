import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { zDemo, zPromotionRequest, zTenant, zTicket } from '../generated/zod.gen.js';
import type { StoreState } from './store.js';

/**
 * The service's durable state: one JSON file, replaced whole by a rename after
 * the new content is on disk, so a crash leaves the old file or the new one and
 * never half of one. The approval ledger is written beside it in the shape the
 * controller's executor reads (`FileApprovalLedger`); it is derived from the
 * state, so it is written after the state and a failure to write it never
 * refuses a call, and the next write makes it right.
 */

export const STATE_FILE = 'state.json';
export const APPROVALS_FILE = 'approvals.json';

const zState = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  tenants: z.array(z.strictObject({ tenant: zTenant, demo: zDemo })),
  requests: z.array(zPromotionRequest),
  // A state written before tickets existed has none.
  tickets: z.array(zTicket).default([]),
});

export class StateFileError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string
  ) {
    super(`${path} cannot be used: ${problem}.`);
    this.name = 'StateFileError';
  }
}

const OTHERS = 0o077;

/** The state, or undefined when no file has been written yet. Anything else wrong is an error. */
export function readState(dir: string): StoreState | undefined {
  const path = join(dir, STATE_FILE);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw new StateFileError(path, 'it cannot be opened');
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new StateFileError(path, 'it is not a regular file');
    if (info.uid !== process.getuid?.())
      throw new StateFileError(path, 'it belongs to another user');
    if ((info.mode & OTHERS) !== 0) throw new StateFileError(path, 'other users can reach it');
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new StateFileError(path, 'it is not JSON');
    }
    const parsed = zState.safeParse(json);
    if (!parsed.success) throw new StateFileError(path, 'it does not have the shape of the state');
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}

function writeWhole(path: string, text: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(join(path, '..'), constants.O_RDONLY);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Writes the state. A failure throws, and the caller refuses the change. */
export function writeState(dir: string, state: StoreState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeWhole(join(dir, STATE_FILE), `${JSON.stringify(state)}\n`);
}

/** The ledger the controller's executor reads: one entry per approved request. */
export function writeApprovals(dir: string, state: StoreState): void {
  const approvals = state.requests.flatMap((request) =>
    request.approval === null
      ? []
      : [
          {
            approvalId: request.approval.approval_id,
            tenantId: request.approval.tenant_id,
            approvedAt: request.approval.approved_at,
            scopes: request.approval.scopes,
          },
        ]
  );
  writeWhole(join(dir, APPROVALS_FILE), `${JSON.stringify({ approvals })}\n`);
}
