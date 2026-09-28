/**
 * A deliberately tiny YAML emitter for the one document this component
 * produces — not a general serialiser or dependency. Every string is
 * single-quoted unconditionally, to remove YAML's plain-scalar surprise
 * class rather than reason about each one. See yaml.md#toyaml.
 */

export type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

const INDENT = '  ';

/**
 * Characters a single-quoted YAML scalar cannot carry faithfully. A newline
 * is *legal* YAML there — it folds or begins a new document line — so a
 * tenant-supplied value carrying one can break out into document structure
 * (e.g. a new mapping key) that the runtime-posture check never sees.
 * See yaml.md#unquotable.
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
