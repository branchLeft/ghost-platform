/**
 * The fields of `sent` that `parsed` does not have, as dotted paths.
 *
 * The generated request schemas are non-strict objects: a field the spec does
 * not declare is silently dropped from the parsed copy rather than refused,
 * although the spec says `additionalProperties: false`. The descriptor was
 * always refused for an unknown field (render-core's own check), so the gate
 * compares what was sent with what was parsed and refuses any difference.
 */
export function unknownFieldPaths(sent: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(sent) && Array.isArray(parsed)) {
    return sent.flatMap((item, index) =>
      unknownFieldPaths(item, parsed[index], `${path}[${index}]`)
    );
  }
  if (!isRecord(sent) || !isRecord(parsed)) return [];
  return Object.keys(sent).flatMap((key) => {
    const here = path === '' ? key : `${path}.${key}`;
    return Object.prototype.hasOwnProperty.call(parsed, key)
      ? unknownFieldPaths(sent[key], parsed[key], here)
      : [here];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
