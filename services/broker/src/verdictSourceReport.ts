import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import { slotDir } from './slotPorts.js';

/** Ghost's three separate storage adapters; every one must name the source. */
const STORAGE_FEATURES = ['images', 'media', 'files'] as const;

/** The only value the scanning adapter treats as a real verdict source. */
const PRODUCTION = 'production';

const VERDICT_SOURCE_LINE =
  /^\s*["']?storage__(images|media|files)__verdictSource["']?\s*:\s*(.*?)\s*$/;

/** A scalar as render-core writes it: single-quoted, or bare. Anything else is no match. */
function scalarValue(raw: string): string | undefined {
  const quoted = /^'([^']*)'$/.exec(raw) ?? /^"([^"\\]*)"$/.exec(raw);
  if (quoted) return quoted[1];
  return /^[^\s'"#]+$/.test(raw) ? raw : undefined;
}

/**
 * Whether a rendered `compose.yml` names the production verdict source for
 * every storage feature. Fails closed: `true` only when each of `images`,
 * `media` and `files` has a `storage__<feature>__verdictSource` line and
 * every such line (a compose file carries one set per colour) is exactly
 * `production`. An absent key, any other value, an unparsable value and an
 * empty file are all `false`.
 */
export function composeNamesProductionVerdictSource(compose: string): boolean {
  const seen = new Map<string, string[]>();
  for (const line of compose.split('\n')) {
    const match = VERDICT_SOURCE_LINE.exec(line);
    const feature = match?.[1];
    if (feature === undefined) continue;
    const values = seen.get(feature) ?? [];
    values.push(scalarValue(match?.[2] ?? '') ?? '');
    seen.set(feature, values);
  }
  return STORAGE_FEATURES.every((feature) => {
    const values = seen.get(feature);
    return values !== undefined && values.length > 0 && values.every((v) => v === PRODUCTION);
  });
}

/**
 * What `/status` reports as `productionVerdictSource` for one slot: read from
 * the `compose.yml` render-core wrote into the slot's directory, never from a
 * flag. A slot never rendered, or a file that cannot be read, is `false`.
 */
export async function slotNamesProductionVerdictSource(
  slotDirBase: string,
  slot: SlotName
): Promise<boolean> {
  try {
    const compose = await readFile(join(slotDir(slotDirBase, slot), 'compose.yml'), 'utf8');
    return composeNamesProductionVerdictSource(compose);
  } catch {
    return false;
  }
}
