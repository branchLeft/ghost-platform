/**
 * The reviewed-difference machinery for tenant zero. See
 * ../tenant-zero.md#the-reviewed-difference.
 */

/** One value that differs between what 5.0.0 rendered and what render-core renders. */
export interface Difference {
  readonly change: 'added' | 'removed' | 'changed';
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
}

/** One reviewed entry: a named group of differences with a verdict and a one-line reason. */
export interface ReviewedEntry {
  readonly id: string;
  readonly status: 'intended' | 'defect';
  /** Explicit paths, or a prefix ending in `*`. */
  readonly paths: readonly string[];
  readonly reason: string;
}

type Flat = Map<string, string>;

function unquote(raw: string): string {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

/**
 * Flattens the document `src/yaml.ts` emits (maps, sequences, single-quoted
 * strings, numbers, booleans; two-space indent) into `a.b.0.c` paths. This
 * reads only that emitter's own grammar, and throws on a line it does not
 * recognise rather than skipping it, so a change to the emitter fails here
 * instead of dropping lines from the comparison.
 */
export function flattenEmitted(text: string, prefix: string): Flat {
  const out: Flat = new Map();
  const stack: { indent: number; key: string; index: number }[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    while (stack.length > 0 && (stack.at(-1) as { indent: number }).indent >= indent) stack.pop();
    const parent = [prefix, ...stack.map((frame) => frame.key)].join('.');
    if (body.startsWith('- ')) {
      const owner = stack.at(-1);
      if (owner === undefined || owner.indent >= indent) {
        throw new Error(`flattenEmitted: list item with no owning key: ${line}`);
      }
      out.set(`${parent}.${owner.index++}`, unquote(body.slice(2)));
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+):(?: (.*))?$/.exec(body);
    if (match === null) throw new Error(`flattenEmitted: unrecognised line: ${line}`);
    const key = match[1] as string;
    if (match[2] === undefined) {
      stack.push({ indent, key, index: 0 });
    } else {
      out.set(`${parent}.${key}`, unquote(match[2]));
    }
  }
  return out;
}

/** `KEY=value` lines as `<prefix>.KEY`; comment lines are ignored (wording is reviewed separately). */
export function flattenEnvFile(text: string, prefix: string): Flat {
  const out: Flat = new Map();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) throw new Error(`flattenEnvFile: unrecognised line: ${line}`);
    out.set(`${prefix}.${match[1]}`, match[2] as string);
  }
  return out;
}

/** A JSON object of scalars (and one level of nesting) as `<prefix>.key` paths. */
export function flattenJson(value: unknown, prefix: string, out: Flat = new Map()): Flat {
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) flattenJson(item, `${prefix}.${key}`, out);
  } else {
    out.set(prefix, String(value));
  }
  return out;
}

/** Every path whose value differs, sorted by path. */
export function differences(before: Flat, after: Flat): Difference[] {
  const found: Difference[] = [];
  for (const [path, value] of before) {
    const other = after.get(path);
    if (other === undefined) found.push({ change: 'removed', path, before: value });
    else if (other !== value) found.push({ change: 'changed', path, before: value, after: other });
  }
  for (const [path, value] of after) {
    if (!before.has(path)) found.push({ change: 'added', path, after: value });
  }
  return found.sort((x, y) => x.path.localeCompare(y.path));
}

function covers(entry: ReviewedEntry, path: string): boolean {
  return entry.paths.some((pattern) =>
    pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern
  );
}

/** The differences no reviewed entry covers: what a reviewer has not yet judged. */
export function unreviewed(
  found: readonly Difference[],
  reviewed: readonly ReviewedEntry[]
): Difference[] {
  return found.filter((difference) => !reviewed.some((entry) => covers(entry, difference.path)));
}

/** The reviewed entries that match no difference: a judgement about something that no longer happens. */
export function stale(
  found: readonly Difference[],
  reviewed: readonly ReviewedEntry[]
): ReviewedEntry[] {
  return reviewed.filter((entry) => !found.some((difference) => covers(entry, difference.path)));
}

/** A path matched by more than one entry: a difference judged twice, possibly two ways. */
export function judgedTwice(
  found: readonly Difference[],
  reviewed: readonly ReviewedEntry[]
): string[] {
  return found
    .filter((difference) => reviewed.filter((entry) => covers(entry, difference.path)).length > 1)
    .map((difference) => difference.path);
}
