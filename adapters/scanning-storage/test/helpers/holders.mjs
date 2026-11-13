import fs from 'node:fs/promises';
import path from 'node:path';

// Reads every holder entry in a digest's sidecar directory and folds them
// into one view, {owners: {<owner>: [targets]}, stuck?: {<owner>: {...}}},
// so a test can state what is held without knowing the entry file names.
// Throws when there is no sidecar.
export async function holdersOf(quarantinePath, digest) {
  const dir = path.join(quarantinePath, `${digest}.holds.json`);
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  const view = { owners: {} };
  for (const name of names.sort()) {
    const holder = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    view.owners[holder.owner] = [...(view.owners[holder.owner] || []), ...holder.targets];
    if (holder.stuck) view.stuck = { ...view.stuck, [holder.owner]: holder.stuck };
  }
  return view;
}
