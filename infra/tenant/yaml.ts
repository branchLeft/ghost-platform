/**
 * A deliberately tiny YAML emitter for the one document this component
 * produces.
 *
 * Not a general serialiser and not a dependency: the alternative was adding a
 * YAML library to a package whose whole output is one fixed-shape document,
 * and a general emitter's quoting rules are a larger surface to reason about
 * than the four value types below. It handles maps, sequences, strings,
 * finite numbers and booleans, and throws on anything else rather than
 * emitting something that parses differently than it reads.
 *
 * Every string is single-quoted. YAML's plain scalars are where the format's
 * surprises live — `no` parses as `false`, `10:00` as a sexagesimal integer,
 * a leading `*` as an alias — and a Compose file carries UIDs, ports and
 * image digests that sit close to all three. Quoting unconditionally costs
 * some readability on the host and removes the entire class.
 */

export type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

const INDENT = '  ';

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function scalar(value: YamlValue): string {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`toYaml: ${value} is not a finite number.`);
    }
    return String(value);
  }
  throw new Error(`toYaml: unsupported scalar ${typeof value}.`);
}

function isContainer(value: YamlValue): boolean {
  return typeof value === 'object' && value !== null;
}

function emit(value: YamlValue, depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error('toYaml: an empty sequence has no unambiguous block form.');
    }
    for (const item of value) {
      if (isContainer(item)) {
        // A nested container under `- ` is emitted one level deeper and its
        // first line spliced onto the dash, so the dash and the first key
        // share a line the way a hand-written Compose file does.
        const nested: string[] = [];
        emit(item, depth + 1, nested);
        lines.push(`${pad}- ${nested[0].slice((depth + 1) * INDENT.length)}`);
        lines.push(...nested.slice(1));
      } else {
        lines.push(`${pad}- ${scalar(item)}`);
      }
    }
    return;
  }

  if (isContainer(value)) {
    const entries = Object.entries(value as { [key: string]: YamlValue });
    if (entries.length === 0) {
      throw new Error('toYaml: an empty mapping has no unambiguous block form.');
    }
    for (const [key, child] of entries) {
      if (isContainer(child)) {
        lines.push(`${pad}${key}:`);
        emit(child, depth + 1, lines);
      } else {
        lines.push(`${pad}${key}: ${scalar(child)}`);
      }
    }
    return;
  }

  lines.push(`${pad}${scalar(value)}`);
}

export function toYaml(document: YamlValue): string {
  const lines: string[] = [];
  emit(document, 0, lines);
  return `${lines.join('\n')}\n`;
}
