// Types for derive-script-hashes.mjs, so the typed isolation suite can call it
// with its own fetch.
export type DerivedThemeCsp =
  { kind: 'computed'; hashes: string[] } | { kind: 'unavailable'; reason: string };

export function scriptHashOf(scriptText: string): string;
export function inlineScriptTextsIn(html: string): string[];
export function deriveScriptHashes(pages: readonly string[]): string[];
export const DEFAULT_PAGE_TIMEOUT_MS: number;

export function deriveThemeCsp(
  origin: string,
  paths: readonly string[],
  fetchImpl?: (
    url: URL,
    init: { signal?: AbortSignal }
  ) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>,
  timeoutMs?: number
): Promise<DerivedThemeCsp>;
