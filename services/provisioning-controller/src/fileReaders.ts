import { TrustedFileError, readTrustedJson } from './trustedFile.js';
import {
  APPROVAL_SCOPES,
  type ApprovalLedger,
  type RecordedApproval,
  type RegisterEntry,
  type TenantRegisterReader,
} from './ports.js';

/**
 * The approval ledger and the tenant register as files the owner's tooling
 * writes. They stand in for the console and the portal register, whose real
 * adapters are separate work: the controller sees only the narrow shape it
 * needs. Both read the file again on every call, so an approval withdrawn
 * between two steps is seen at the next check. Anything unreadable, malformed
 * or ambiguous (the same id twice) throws, and a throw stops the run.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function listAt(path: string, doc: unknown, field: string): readonly unknown[] {
  if (!isRecord(doc) || !Array.isArray(doc[field])) {
    throw new TrustedFileError(path, `it has no "${field}" list`);
  }
  return doc[field] as readonly unknown[];
}

function asApproval(path: string, raw: unknown): RecordedApproval {
  if (
    !isRecord(raw) ||
    !isText(raw['approvalId']) ||
    !isText(raw['tenantId']) ||
    !isText(raw['approvedAt']) ||
    !Array.isArray(raw['scopes']) ||
    !raw['scopes'].every((s) => (APPROVAL_SCOPES as readonly unknown[]).includes(s))
  ) {
    throw new TrustedFileError(path, 'an approval in it is malformed');
  }
  return {
    approvalId: raw['approvalId'],
    tenantId: raw['tenantId'],
    approvedAt: raw['approvedAt'],
    scopes: raw['scopes'] as RecordedApproval['scopes'],
  };
}

function asEntry(path: string, raw: unknown): RegisterEntry {
  if (
    !isRecord(raw) ||
    !isText(raw['tenantId']) ||
    typeof raw['mediaFolder'] !== 'string' ||
    typeof raw['mediaBucket'] !== 'string' ||
    typeof raw['appHostSlot'] !== 'string' ||
    typeof raw['appHostPort'] !== 'number' ||
    typeof raw['appHostUid'] !== 'number' ||
    !Array.isArray(raw['hostnames']) ||
    !raw['hostnames'].every((h) => typeof h === 'string')
  ) {
    throw new TrustedFileError(path, 'a register entry in it is malformed');
  }
  return {
    tenantId: raw['tenantId'],
    mediaFolder: raw['mediaFolder'],
    mediaBucket: raw['mediaBucket'],
    appHostSlot: raw['appHostSlot'],
    appHostPort: raw['appHostPort'],
    appHostUid: raw['appHostUid'],
    hostnames: raw['hostnames'] as readonly string[],
  };
}

export class FileApprovalLedger implements ApprovalLedger {
  constructor(private readonly path: string) {}

  async find(approvalId: string): Promise<RecordedApproval | undefined> {
    const all = listAt(this.path, await readTrustedJson(this.path), 'approvals').map((a) =>
      asApproval(this.path, a)
    );
    const matches = all.filter((a) => a.approvalId === approvalId);
    if (matches.length > 1) throw new TrustedFileError(this.path, 'an approval id appears twice');
    return matches[0];
  }
}

export class FileRegisterReader implements TenantRegisterReader {
  constructor(private readonly path: string) {}

  async read(tenantId: string): Promise<RegisterEntry | undefined> {
    const all = listAt(this.path, await readTrustedJson(this.path), 'entries').map((e) =>
      asEntry(this.path, e)
    );
    const matches = all.filter((e) => e.tenantId === tenantId);
    if (matches.length > 1) throw new TrustedFileError(this.path, 'a tenant appears twice');
    return matches[0];
  }
}
