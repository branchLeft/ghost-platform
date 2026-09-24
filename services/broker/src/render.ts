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
 * design (workspace#1183, "descriptor to the seven artefacts, pure"; see
 * `render-core/src/index.ts`: "No rendering logic lives here yet"). That
 * story is not built, so this is a seam rather than an implementation: this
 * service depends on the interface, never on a placeholder pretending to be
 * the real thing. `/reconcile` refuses to start (see `server.ts`) if no
 * renderer is wired in, rather than silently writing nothing.
 */
export interface Renderer {
  render(descriptor: TenantDescriptor): Promise<readonly Artefact[]>;
}
