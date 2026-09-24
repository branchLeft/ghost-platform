import { mkdir } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { writeFileAtomic } from './atomicFile.js';
import type { Artefact } from './render.js';

/**
 * Writes each rendered artefact under `<slotDirBase>/<slot>/`, refusing any
 * artefact path that would escape that directory -- a renderer is a
 * dependency this service does not control the implementation of (`render.ts`),
 * so its output is treated as untrusted the same way any other input is,
 * never as already-safe because it came from "our own" code.
 */
export async function writeArtefacts(
  slotDirBase: string,
  slot: SlotName,
  artefacts: readonly Artefact[]
): Promise<void> {
  const root = join(slotDirBase, slot);
  for (const artefact of artefacts) {
    const target = normalize(join(root, artefact.path));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`artefact path "${artefact.path}" escapes the slot directory`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, artefact.content, artefact.mode ?? 0o600);
  }
}
