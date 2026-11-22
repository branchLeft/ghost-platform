// The attacker's content. Every script sets a `window.__ran_<vector>` flag first,
// so the suite can tell "ran and was harmless" from "never ran", and every
// cookie it writes carries the run's attacker value so the suite can tell the
// attacker's cookie from the victim's own.

export interface AttackerContext {
  /** Unique per run; present in every value the attacker writes. */
  readonly value: string;
  /** The shared tenant domain, the widest Domain the attacker tries on a tenant. */
  readonly sharedDomain: string;
  /** The registrable domain above it, which the portal sits under. */
  readonly rootDomain: string;
  /** The victim tenant's session cookie name, which the attacker tries to replace. */
  readonly sessionName: string;
}

export const MARK_PREFIX = '__ran_';

export const BOMB_COOKIES = 8;
export const BOMB_COOKIE_BYTES = 3800;

/** The cookie writes of a tossing attacker, as `document.cookie` assignments. */
export function tossAssignments(a: AttackerContext): string[] {
  return [
    `${a.sessionName}=${a.value}; Domain=${a.sharedDomain}; Path=/ghost`,
    `ghost-members-ssr=${a.value}; Domain=${a.sharedDomain}; Path=/`,
    `toss=${a.value}; Domain=${a.sharedDomain}; Path=/`,
    `toss_root=${a.value}; Domain=${a.rootDomain}; Path=/`,
  ];
}

export function tossNames(a: AttackerContext): string[] {
  return [a.sessionName, 'ghost-members-ssr', 'toss', 'toss_root'];
}

/** The script body that performs the tossing, with its mark. */
export function tossScript(a: AttackerContext): string {
  const writes = tossAssignments(a)
    .map((c) => `document.cookie=${JSON.stringify(c)};`)
    .join('');
  return `window.${MARK_PREFIX}toss=true;${writes}`;
}

export function bombNames(): string[] {
  return Array.from({ length: BOMB_COOKIES }, (_, i) => `bomb${i}`);
}

/** The script body that writes enough cookie bytes to exceed what Ghost accepts in a header. */
export function bombScript(a: AttackerContext): string {
  return (
    `window.${MARK_PREFIX}bomb=true;` +
    `for(var i=0;i<${BOMB_COOKIES};i++){document.cookie='bomb'+i+'='+'x'.repeat(${BOMB_COOKIE_BYTES})+` +
    `'; Domain=${a.sharedDomain}; Path=/; Max-Age=600';}`
  );
}

export function headInjection(a: AttackerContext): string {
  return (
    `<script>window.${MARK_PREFIX}head=true;</script>` +
    `<script>${tossScript(a)}</script>` +
    `<script>${bombScript(a)}</script>`
  );
}

export function footInjection(): string {
  return `<script>window.${MARK_PREFIX}foot=true;</script>`;
}

/** An inline script and an event-handler attribute, both in the post body. */
export function inlineCard(): string {
  return (
    `<script>window.${MARK_PREFIX}post=true;</script>` +
    `<img src="/attack-suite-missing.png" alt="" onerror="window.${MARK_PREFIX}attr=true">`
  );
}

/** The uploaded script file's own text. */
export function uploadedScriptSource(a: AttackerContext): string {
  return `window.${MARK_PREFIX}upload=true;${tossScript(a)}`;
}

export function uploadedHtmlSource(): string {
  return (
    `<!doctype html><html><body><script>window.${MARK_PREFIX}upload_html=true;</script>` +
    `<script src="/content/files/attack-suite.js"></script></body></html>`
  );
}

export function uploadedSvgSource(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
    `<script>window.${MARK_PREFIX}upload_svg=true;</script></svg>`
  );
}

export function scriptCard(src: string): string {
  return `<script src="${src}"></script>`;
}

/** A form that a reader submits with one click, with no script involved. */
export function forgedFormCard(action: string): string {
  return (
    `<form method="POST" action="${action}">` +
    `<button id="attack-suite-submit" type="submit">Continue</button></form>`
  );
}

/** The hostile theme's files, added to the base theme. */
export function hostileThemeFiles(a: AttackerContext): Record<string, string> {
  return {
    'default.hbs':
      '<!DOCTYPE html><html><head>{{ghost_head}}' +
      `<script>window.${MARK_PREFIX}theme_inline=true;</script>` +
      '<script src="{{asset "js/attack.js"}}"></script>' +
      '</head><body>{{{body}}}{{ghost_foot}}</body></html>',
    'assets/js/attack.js': `window.${MARK_PREFIX}theme_asset=true;${tossScript(a)}`,
  };
}
