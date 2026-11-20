/** The one thing the recorder needs of the owner's database layer, plus the slug lookup. */
export interface ErasureSink {
  listTenantSlugs(): Promise<Array<{ slug: string; tenantId: string }>>;
  recordKeyDestroyed(tenantId: string): Promise<boolean>;
}

/**
 * What the control host's erase command prints, in full, when it has read every
 * location back and found no copy of the tenant's key. Nothing else it prints
 * is a proof: `no copy of its backup identity was present; nothing to erase` is
 * exit 0 as well, and it is also what a tenant that was never enrolled gets, so
 * it proves nothing about a key that existed. A test reads the command's own
 * source to hold this text to it.
 */
export const PROOF_GREEN_TEXT =
  'proof green: the identity directory, the spare bucket (objects and versions) ' +
  'and both lists were read back and hold no copy';

const COMMAND = 'erase_tenant_backup_identity';
const GREEN_LINE = new RegExp(`^${COMMAND}: ([a-z0-9-]+): ${escapeRegExp(PROOF_GREEN_TEXT)}$`);
/** The command prefixes every red or unreadable finding with this word, on standard error. */
const ALERT = `${COMMAND}: ALERT:`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Why the text was not recorded, as the run log says it. */
export type NotRecorded =
  | 'no-green-proof'
  | 'red-proof'
  | 'more-than-one-tenant'
  | 'unknown-tenant'
  | 'no-request-waiting'
  | 'write-failed';

export type RecordOutcome =
  | { readonly recorded: true; readonly slug: string }
  | { readonly recorded: false; readonly why: NotRecorded };

/**
 * Records that a tenant's backup key is destroyed, from the erase command's
 * own output and from nothing else. It records only when the text holds the
 * command's full green proof line for exactly one tenant, no ALERT line, a tenant
 * the register names, and a request from that tenant still waiting. Anything
 * short of that records nothing, so the portal can never say a key is destroyed
 * on the strength of a command that did not prove it, for a tenant that did not
 * ask, or from text naming several tenants at once.
 *
 * The log line carries the slug at most and never any of the text.
 */
export async function recordKeyDestruction(
  sink: ErasureSink,
  text: string,
  log: (line: string) => void
): Promise<RecordOutcome> {
  const lines = text.split(/\r?\n/);
  const refuse = (why: NotRecorded, slug?: string): RecordOutcome => {
    log(`erasure: ${slug === undefined ? '' : `${slug}: `}not recorded: ${why}`);
    return { recorded: false, why };
  };
  if (lines.some((line) => line.startsWith(ALERT))) return refuse('red-proof');
  const green = new Set<string>();
  for (const line of lines) {
    const match = GREEN_LINE.exec(line);
    if (match !== null) green.add(match[1] as string);
  }
  if (green.size === 0) return refuse('no-green-proof');
  if (green.size > 1) return refuse('more-than-one-tenant');
  const slug = [...green][0] as string;
  const tenant = (await sink.listTenantSlugs()).find((t) => t.slug === slug);
  if (tenant === undefined) return refuse('unknown-tenant', slug);
  let changed: boolean;
  try {
    changed = await sink.recordKeyDestroyed(tenant.tenantId);
  } catch {
    return refuse('write-failed', slug);
  }
  if (!changed) return refuse('no-request-waiting', slug);
  log(`erasure: ${slug}: recorded key destroyed`);
  return { recorded: true, slug };
}
