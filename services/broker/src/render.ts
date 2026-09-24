import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';

/** One file `/reconcile` writes into the slot's directory before starting it. */
export interface Artefact {
  readonly path: string;
  readonly content: string;
  /** Octal file mode; defaults to 0o600 (owner read/write only) when omitted. */
  readonly mode?: number;
}

/**
 * The descriptor-to-artefacts step LLD-2 §03 calls "render" -- pure by
 * design. Filled by `plugins/renderCorePlugin.ts`, which adapts
 * `render-core`'s own `render()` to this interface; this service still
 * depends on the interface, never on a placeholder pretending to be the
 * real thing, so `/reconcile` refuses to start (see `server.ts`) if no
 * renderer is wired in via `BROKER_RENDERER_MODULE`, rather than silently
 * writing nothing.
 */
export interface Renderer {
  render(descriptor: TenantDescriptor): Promise<readonly Artefact[]>;
}
