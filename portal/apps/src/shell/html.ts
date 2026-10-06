export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface NavItem {
  readonly label: string;
  readonly href: string;
}

export interface Page {
  readonly title: string;
  readonly nav: readonly NavItem[];
  readonly signOutLabel: string;
  /** Already-escaped markup. */
  readonly body: string;
}

export const STYLESHEET =
  'body{font-family:system-ui,sans-serif;margin:0}header{display:flex;gap:1rem;padding:1rem;border-bottom:1px solid #ccc}' +
  'main{padding:1rem}nav{display:flex;gap:1rem;flex:1}form{margin:0}\n';

/** The shell both applications render: navigation, a landing area and sign-out. */
export function renderPage(page: Page): string {
  const nav = page.nav
    .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`)
    .join('');
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(page.title)}</title><link rel="stylesheet" href="/shell.css"></head><body>` +
    `<header><strong>${escapeHtml(page.title)}</strong><nav>${nav}</nav>` +
    `<form method="post" action="/logout"><button type="submit">${escapeHtml(page.signOutLabel)}</button></form></header>` +
    `<main>${page.body}</main></body></html>`
  );
}
