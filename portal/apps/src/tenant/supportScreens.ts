/** The recorded screen when a ticket's route is not one of the portal's own. */
export const UNKNOWN_SCREEN = 'UNKNOWN_SCREEN';

export type SupportScreen = 'HOME' | 'DOCUMENTS' | 'MODERATION' | 'SUPPORT';

export type RecordedScreen = SupportScreen | typeof UNKNOWN_SCREEN;

export interface SupportEntry {
  readonly screen: SupportScreen;
  /** Where the form for a ticket raised from this screen is served. */
  readonly pagePath: string;
  /** Where that form posts: the only thing that says which screen the ticket came from. */
  readonly sendPath: string;
}

const PATHS: Readonly<Record<SupportScreen, Pick<SupportEntry, 'pagePath' | 'sendPath'>>> = {
  HOME: { pagePath: '/support/home', sendPath: '/support/home/send' },
  DOCUMENTS: { pagePath: '/support/documents', sendPath: '/support/documents/send' },
  MODERATION: { pagePath: '/support/moderation', sendPath: '/support/moderation/send' },
  SUPPORT: { pagePath: '/support', sendPath: '/support/send' },
};

export function entryFor(screen: SupportScreen): SupportEntry {
  return { screen, ...PATHS[screen] };
}

/**
 * The closed list of the portal's screens. The shell renders a page without
 * the request and its navigation is the same everywhere, so the screen a
 * ticket was raised from is carried by the path of the support form that each
 * screen links to. Nothing about it is read from a query, header or field.
 */
export const SUPPORT_SCREENS: readonly SupportEntry[] = (
  ['HOME', 'DOCUMENTS', 'MODERATION', 'SUPPORT'] as const
).map(entryFor);

/** The screen a send path belongs to, or UNKNOWN_SCREEN for any path outside the table. */
export function screenForSendPath(path: string): RecordedScreen {
  return SUPPORT_SCREENS.find((entry) => entry.sendPath === path)?.screen ?? UNKNOWN_SCREEN;
}
