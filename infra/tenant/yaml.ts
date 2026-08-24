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
 *
 * Quoting is not escaping, and the difference is the reason `quote` refuses
 * control characters outright: a single-quoted scalar has exactly one escape
 * (a doubled quote) and no representation at all for a newline that does not
 * change the document's structure. Refusing is the only faithful option, so
 * this emitter throws rather than emitting a string it cannot round-trip.
 */

export type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

const INDENT = '  ';

/**
 * Characters a single-quoted YAML scalar cannot carry faithfully.
 *
 * A newline inside a single-quoted scalar is *legal* YAML — it folds, or
 * begins a new document line — which is exactly why it has to be refused
 * rather than emitted. A tenant-supplied value carrying one breaks out of its
 * scalar and its remainder is parsed as document structure: at the right
 * indentation that is a new mapping key, and `cap_add:` is a mapping key. The
 * runtime-posture check cannot see it, because that runs over the object
 * before serialisation and the object holds one well-formed string.
 *
 * So the refusal is here, at the one place that turns objects into document
 * text. C0 controls, DEL and the C1 range go with it: none of them belongs in
 * a Compose file, and each has its own way of being read differently than it
 * looks.
 */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const UNQUOTABLE = /[\u0000-\u001f\u007f-\u009f]/;

function quote(value: string): string {
  const offending = UNQUOTABLE.exec(value);
  if (offending) {
    const code = offending[0].codePointAt(0) ?? 0;
    throw new Error(
      `toYaml: refusing to emit a string containing U+${code.toString(16).toUpperCase().padStart(4, '0')} ` +
        `at index ${offending.index}. A control character in a quoted scalar is either re-read as ` +
        `document structure or silently transformed, so there is no faithful single-quoted form of it.`
    );
  }
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
      // A key is document text exactly as a value is, and a mapping key is
      // the shape an injected line takes.
      quote(key);
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
