import { parseTenantKind } from 'ghost-platform-portal-data/tenant';
import { escapeHtml } from '../shell/html.js';
import { entryFor, type SupportScreen } from './supportScreens.js';

/**
 * The explainer and the FAQ in the tenant portal. Structure and routing only:
 * every word a reader sees is an ALL_CAPS placeholder naming what the owner's
 * copy must cover. Both pages are for a REAL tenant; a DEMO slot is given a
 * placeholder notice and nothing of the content.
 */

export interface ExplainerSection {
  readonly heading: string;
  readonly body: string;
}

export const EXPLAINER_SECTIONS: readonly ExplainerSection[] = [
  { heading: 'EXPLAINER_PLATFORM_HEADING', body: 'EXPLAINER_PLATFORM_COVERS_WHAT_THE_SERVICE_IS' },
  { heading: 'EXPLAINER_SITE_HEADING', body: 'EXPLAINER_SITE_COVERS_YOUR_SITE_AND_ITS_PARTS' },
  { heading: 'EXPLAINER_CONTENT_HEADING', body: 'EXPLAINER_CONTENT_COVERS_PUBLISHING_AND_EDITING' },
  { heading: 'EXPLAINER_MEMBERS_HEADING', body: 'EXPLAINER_MEMBERS_COVERS_READERS_AND_ACCESS' },
  {
    heading: 'EXPLAINER_MODERATION_HEADING',
    body: 'EXPLAINER_MODERATION_COVERS_CHECKS_FLOORS_AND_APPEALS',
  },
  {
    heading: 'EXPLAINER_DOCUMENTS_HEADING',
    body: 'EXPLAINER_DOCUMENTS_COVERS_TERMS_AND_ACCEPTANCE',
  },
  { heading: 'EXPLAINER_HELP_HEADING', body: 'EXPLAINER_HELP_COVERS_WHERE_TO_GET_SUPPORT' },
];

/**
 * Where a FAQ answer sends the tenant: a support form (only when support is
 * switched on) or a self-service page of the portal itself.
 */
export type FaqRoute =
  | { readonly kind: 'SUPPORT'; readonly screen: SupportScreen }
  | { readonly kind: 'SELF_SERVICE'; readonly href: string };

export interface FaqEntry {
  readonly id: string;
  readonly route: FaqRoute;
}

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  { id: 'FAQ_1', route: { kind: 'SUPPORT', screen: 'HOME' } },
  { id: 'FAQ_2', route: { kind: 'SELF_SERVICE', href: '/documents' } },
  { id: 'FAQ_3', route: { kind: 'SELF_SERVICE', href: '/moderation' } },
  { id: 'FAQ_4', route: { kind: 'SUPPORT', screen: 'SUPPORT' } },
];

/** The FAQ entries this portal can route: a support route is dropped when support is off. */
export function faqEntriesFor(supportOn: boolean): readonly FaqEntry[] {
  return FAQ_ENTRIES.filter((entry) => supportOn || entry.route.kind !== 'SUPPORT');
}

function hrefFor(route: FaqRoute): string {
  return route.kind === 'SUPPORT' ? entryFor(route.screen).pagePath : route.href;
}

export function renderExplainerPage(): string {
  const sections = EXPLAINER_SECTIONS.map(
    (section) => `<section><h2>${section.heading}</h2><p>${section.body}</p></section>`
  ).join('');
  return `<h1>EXPLAINER_TITLE</h1>${sections}`;
}

export function renderFaqPage(supportOn: boolean): string {
  const items = faqEntriesFor(supportOn).map(
    (entry) =>
      `<section><h2>${entry.id}_QUESTION</h2><p>${entry.id}_ANSWER_COVERS_THE_ROUTE_TAKEN</p>` +
      `<p><a href="${escapeHtml(hrefFor(entry.route))}">${entry.id}_ROUTE_LABEL</a></p></section>`
  );
  return `<h1>FAQ_TITLE</h1>${items.join('')}`;
}

export function renderDemoNotice(): string {
  return '<h1>DEMO_NO_EXPLAINER</h1>';
}

/**
 * The page body for a tenant, given its kind. A kind that is absent or not a
 * recognised one throws, so the page fails rather than showing content.
 */
export async function payingOnlyBody<S>(
  scope: S,
  kindOf: (scope: S) => Promise<unknown>,
  render: () => string
): Promise<string> {
  const kind = parseTenantKind(await kindOf(scope));
  return kind === 'REAL' ? render() : renderDemoNotice();
}

/** The landing links to the explainer and the FAQ, for a REAL tenant only. */
export function explainerLinks(kind: unknown): string {
  return kind === 'REAL'
    ? '<p><a href="/explainer">EXPLAINER_LINK</a> <a href="/faq">FAQ_LINK</a></p>'
    : '';
}
