/**
 * Whether each loaded plugin seam is a shipped, final module. Fails closed:
 * only a default export carrying exactly `real: true` counts as real, so a
 * test stand-in, a hand-written module or anything that forgot the marker
 * is reported. `interim` names shipped modules marked as temporary. `/status`
 * reports both lists; a host is not ready to go live while either is
 * non-empty.
 */
export interface SeamMarker {
  readonly real?: true;
  readonly interim?: true;
}

export interface SeamReadiness {
  readonly notReal: readonly string[];
  readonly interim: readonly string[];
}

function marker(module: unknown, name: keyof SeamMarker): unknown {
  return (module as Record<string, unknown> | null | undefined)?.[name];
}

export function seamReadiness(seams: Readonly<Record<string, unknown>>): SeamReadiness {
  const names = Object.keys(seams).sort();
  return {
    notReal: names.filter((name) => marker(seams[name], 'real') !== true),
    interim: names.filter((name) => {
      const value = marker(seams[name], 'interim');
      return value !== undefined && value !== false;
    }),
  };
}
