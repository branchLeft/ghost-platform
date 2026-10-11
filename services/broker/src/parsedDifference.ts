/**
 * How a parsed copy of a request differs from what was sent, as dotted paths.
 *
 * The generated schemas are not pure checks: a non-strict object drops a
 * field it does not declare, and a string format can rewrite its value. The
 * handler would then act on bytes the caller did not sign, where render-core
 * refused both. The gate refuses any difference.
 */
export interface ParsedDifference {
  /** In `sent`, absent from `parsed`. */
  readonly unknown: string[];
  /** In both, with a different value. */
  readonly altered: string[];
}

export function compareParsed(sent: unknown, parsed: unknown, path = ''): ParsedDifference {
  if (Array.isArray(sent) && Array.isArray(parsed)) {
    return merge(
      sent.map((item, index) => compareParsed(item, parsed[index], `${path}[${index}]`))
    );
  }
  if (isRecord(sent) && isRecord(parsed)) {
    return merge(
      Object.keys(sent).map((key) => {
        const here = path === '' ? key : `${path}.${key}`;
        return Object.prototype.hasOwnProperty.call(parsed, key)
          ? compareParsed(sent[key], parsed[key], here)
          : { unknown: [here], altered: [] };
      })
    );
  }
  return { unknown: [], altered: Object.is(sent, parsed) ? [] : [path] };
}

function merge(parts: ParsedDifference[]): ParsedDifference {
  return {
    unknown: parts.flatMap((part) => part.unknown),
    altered: parts.flatMap((part) => part.altered),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
