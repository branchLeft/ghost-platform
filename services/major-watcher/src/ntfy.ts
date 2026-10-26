// Publishes one message to a self-hosted ntfy topic. This is the whole of
// ntfy's publish interface: an HTTP POST to the topic URL, the message as
// the raw body, a handful of optional headers -- no SDK, no client library.
//
// NTFY_URL and NTFY_TOKEN are read by the CLI from the environment, never
// hardcoded: see README.md "Owed" for what deploying the receiver itself
// still needs.

import { resolveTimeoutMs, rethrowOrTimeout } from './timeout.js';

export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 10000;

export interface NtfyConfig {
  /** Full topic URL, e.g. https://ntfy.branchleft.co.uk/ghost-major-watcher */
  readonly url: string;
  /** Bearer token, only if the self-hosted instance requires auth to publish. */
  readonly token?: string;
  /** Per-request limit in whole milliseconds, 1 to 2147483647; otherwise the default of 10000. */
  readonly timeoutMs?: number;
}

export interface NtfyMessage {
  readonly title: string;
  readonly message: string;
  readonly priority?: 'max' | 'high' | 'default' | 'low' | 'min';
  readonly tags?: readonly string[];
}

export async function publish(
  config: NtfyConfig,
  msg: NtfyMessage,
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const headers: Record<string, string> = {
    Title: msg.title,
    Priority: msg.priority ?? 'high',
  };
  if (msg.tags && msg.tags.length > 0) headers.Tags = msg.tags.join(',');
  if (config.token) headers.Authorization = `Bearer ${config.token}`;

  const limitMs = resolveTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  const signal = AbortSignal.timeout(limitMs);
  let res: Response;
  try {
    res = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: msg.message,
      signal,
    });
  } catch (error) {
    rethrowOrTimeout(signal, `ntfy publish timed out after ${limitMs} ms`, error);
  }

  if (!res.ok) {
    throw new Error(`ntfy publish failed: ${res.status} ${res.statusText}`);
  }
}
