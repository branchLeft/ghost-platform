import { load } from 'js-yaml';

/** One changed value between two renders, keyed by its path. */
export interface DiffEntry {
  change: 'added' | 'removed' | 'changed';
  path: string;
  before?: unknown;
  after?: unknown;
}

/** Flattens a parsed document into `a.b.0.c` paths and leaf values. */
export function flatten(
  value: unknown,
  prefix = '',
  out = new Map<string, unknown>()
): Map<string, unknown> {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      flatten(item, prefix === '' ? `${index}` : `${prefix}.${index}`, out)
    );
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, prefix === '' ? key : `${prefix}.${key}`, out);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

/** Every path whose value differs between two flattened documents. */
export function diff(before: Map<string, unknown>, after: Map<string, unknown>): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const [path, value] of before) {
    if (!after.has(path)) {
      entries.push({ change: 'removed', path, before: value });
    } else if (after.get(path) !== value) {
      entries.push({ change: 'changed', path, before: value, after: after.get(path) });
    }
  }
  for (const [path, value] of after) {
    if (!before.has(path)) {
      entries.push({ change: 'added', path, after: value });
    }
  }
  return entries.sort((x, y) => x.path.localeCompare(y.path) || x.change.localeCompare(y.change));
}

/** A Compose file's comment lines, which a parse would otherwise drop. */
export function commentLines(text: string): Map<string, unknown> {
  return new Map(
    text
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .map((line, index) => [`comment.${index}`, line])
  );
}

/** A Compose file as paths: its parsed body plus its comment header. */
export function composePaths(text: string): Map<string, unknown> {
  const out = flatten(load(text), 'compose');
  for (const [path, value] of commentLines(text)) {
    out.set(`compose.${path}`, value);
  }
  return out;
}

/** An env file as paths: one per line, keyed by variable name or position. */
export function envFilePaths(text: string, prefix: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  text
    .split('\n')
    .filter((line) => line !== '')
    .forEach((line, index) => {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (match === null) {
        out.set(`${prefix}.comment.${index}`, line);
      } else {
        out.set(`${prefix}.${match[1]}`, match[2]);
      }
    });
  return out;
}
