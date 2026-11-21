import type { RegisterEntry } from './ports.js';

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PORT = 65535;

const isId = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

/**
 * A state prefix must not name the tenant: it may not be the tenant id, the
 * slot, the media folder, or contain the slot's name. The register assigns a
 * random identifier, so a value that names the tenant was not drawn at random.
 */
const isNotDerived = (entry: RegisterEntry): boolean => {
  const folder = entry.stateFolder.toLowerCase();
  const slot = entry.appHostSlot.toLowerCase();
  if (folder === entry.tenantId.toLowerCase()) return false;
  if (folder === entry.mediaFolder.toLowerCase()) return false;
  if (slot.length > 0 && folder.includes(slot)) return false;
  return true;
};

/** Names the fields a register entry gets wrong; empty means usable. A missing value is refused, never guessed. */
export function invalidFields(entry: RegisterEntry): string[] {
  const bad: string[] = [];
  if (!OPAQUE.test(entry.mediaFolder)) bad.push('mediaFolder');
  if (!OPAQUE.test(entry.stateFolder) || !isNotDerived(entry)) bad.push('stateFolder');
  if (!OPAQUE.test(entry.mediaBucket)) bad.push('mediaBucket');
  if (!OPAQUE.test(entry.appHostSlot)) bad.push('appHostSlot');
  if (!isId(entry.appHostPort, 1024, MAX_PORT)) bad.push('appHostPort');
  if (!isId(entry.appHostUid, 1000, 2 ** 31 - 1)) bad.push('appHostUid');
  if (entry.hostnames.length === 0 || !entry.hostnames.every((h) => HOSTNAME.test(h))) {
    bad.push('hostnames');
  }
  return bad;
}
