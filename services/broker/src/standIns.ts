/**
 * Names, sorted, every loaded seam whose module marks itself a test
 * stand-in (`standIn: true` on its default export). `/status` reports the
 * list so a go-live check can refuse while it is non-empty. Fails towards
 * reporting: any `standIn` value other than absent or `false` counts, so a
 * mistyped marker still shows up rather than hiding a stand-in.
 */
export function standInSeams(seams: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(seams)
    .filter((name) => {
      const marker = (seams[name] as { standIn?: unknown } | null | undefined)?.standIn;
      return marker !== undefined && marker !== false;
    })
    .sort();
}
