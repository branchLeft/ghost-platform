// Everything the case drivers share: the two tenants, the portal, the
// attacker's own web server, and what the attacker has planted. A driver gets
// a World and returns an observation; it never starts or stops anything.

import type { Browser } from 'playwright';
import type { GhostAdmin } from './ghostAdmin.ts';
import type { PslState } from './model.ts';
import type { AttackerContext } from './payloads.ts';

export interface TenantHandle {
  readonly host: string;
  readonly origin: string;
  readonly secure: boolean;
  readonly admin: GhostAdmin;
}

export interface PortalHandle {
  readonly host: string;
  readonly origin: string;
  /** The path that makes the portal set its cookies. */
  readonly loginPath: string;
  /** Present only for the local stand-in, which can also be signed in and asked what it read. */
  readonly signedInPath: string | null;
  readonly whoamiPath: string | null;
}

export interface EvilHandle {
  readonly origin: string;
  /** Requests the attacker's server received, newest last, for evidence only. */
  readonly seen: string[];
  aimAt(target: string): void;
}

export interface UploadedFile {
  readonly kind: 'js' | 'html' | 'svg';
  readonly name: string;
  readonly uploadStatus: number;
  /** The path Ghost says serves the file, or null when Ghost refused it. */
  readonly path: string | null;
}

export interface Planted {
  readonly inlinePostPath: string;
  readonly uploadPostPath: string | null;
  readonly csrfPostPath: string;
  readonly uploads: readonly UploadedFile[];
  readonly victimPostId: string;
}

export interface World {
  readonly browser: Browser;
  readonly a: TenantHandle;
  readonly b: TenantHandle;
  readonly portal: PortalHandle;
  readonly evil: EvilHandle;
  readonly attacker: AttackerContext;
  readonly psl: PslState;
  readonly planted: Planted;
}
