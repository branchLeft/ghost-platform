// What a browser run observed, per case. These are plain data: the drivers in
// src/attacks fill them in, src/verdicts.ts judges them, and neither knows how
// the other works.

export interface CookieView {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
}

export interface Violation {
  readonly directive: string;
  readonly blockedURI: string;
}

export interface UploadVector {
  readonly name: string;
  /** Ghost accepted the upload. False means Ghost refused it before the edge saw it. */
  readonly uploaded: boolean;
  readonly uploadStatus: number;
  /** The status the browser got for the uploaded file's own URL. */
  readonly fileStatus: number | null;
  /** The uploaded script or document executed in the page. */
  readonly ran: boolean;
}

export interface UploadedScriptObservation {
  readonly vectors: readonly UploadVector[];
}

export interface InlineScriptObservation {
  /** Which `window.__ran_*` flags were set, across every page visited. */
  readonly marks: Readonly<Record<string, boolean>>;
  readonly violations: readonly Violation[];
  readonly portalSignIn: { readonly rendered: boolean; readonly emailFields: number };
  readonly pagesVisited: number;
}

export interface TossResidual {
  /** The browser accepted a write to the shared parent domain from a tenant origin. */
  readonly sharedDomainWriteAccepted: boolean;
  /** The other tenant's requests carried the tossed cookie. */
  readonly seenByOtherTenant: boolean;
  /** The portal's requests carried it (a write to the registrable domain). */
  readonly seenByPortal: boolean;
}

export interface TossObservation {
  readonly pagesVisited: number;
  /** The attacker's own script ran on the sibling tenant's page. */
  readonly scriptRan: boolean;
  /** Every cookie the victim's browser would send to the victim tenant afterwards. */
  readonly victimJar: readonly CookieView[];
  /** Names the attacker tried to write. */
  readonly attackerNames: readonly string[];
  readonly attackerValue: string;
  readonly sessionBefore: string;
  readonly sessionAfter: string | null;
  readonly residual: TossResidual | null;
  readonly psl: 'absent' | 'present';
}

export interface PortalCookieProbe {
  readonly name: string;
  readonly genuineValue: string;
  /** The values the portal's URL would be sent under this name, across every path attacked. */
  readonly jarValues: readonly string[];
  readonly secure: boolean;
  readonly path: string;
  /** No Domain attribute: the cookie is pinned to the portal host. */
  readonly hostOnly: boolean;
  /** The attacker's value is in the jar under this exact name. */
  readonly attackerValueInJar: boolean;
}

export interface PortalCookieObservation {
  readonly probes: readonly PortalCookieProbe[];
  /** What the portal read as its session after the attacks; null where the target cannot be signed in. */
  readonly sessionRead: { readonly seen: string | null; readonly genuine: string } | null;
  /** Unprefixed twins the browser accepted for the portal, reported only. */
  readonly twinsAccepted: readonly string[];
}

export interface BombResidual {
  readonly cookieBytes: number;
  readonly statusWithBomb: number | null;
  readonly statusAfterClear: number | null;
  readonly sharedDomainWriteAccepted: boolean;
}

export interface BombObservation {
  readonly pagesVisited: number;
  readonly scriptRan: boolean;
  readonly victimStatus: number | null;
  readonly bombBytesInVictimJar: number;
  readonly residual: BombResidual | null;
  readonly psl: 'absent' | 'present';
}

export interface CrossSiteVector {
  readonly name: string;
  readonly origin: 'cross-site' | 'same-site';
  /** Requests the browser sent to the victim tenant's state-changing URL. */
  readonly requestsToVictim: number;
  readonly statuses: readonly number[];
}

export interface CrossSiteObservation {
  readonly vectors: readonly CrossSiteVector[];
  readonly postsBefore: number;
  readonly postsAfter: number;
}

export interface ThemeVector {
  readonly name: string;
  readonly ran: boolean;
  readonly fileStatus: number | null;
}

export interface ThemeObservation {
  readonly uploadStatus: number;
  readonly activateStatus: number | null;
  readonly vectors: readonly ThemeVector[];
}
