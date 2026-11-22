// The case catalogue: one control per case, and the sabotage that must turn the
// case red. The control names the code or configuration that is supposed to
// stop the attack, so a red case says what to look at.

import type { CaseId, SabotageMode } from './model.ts';

export interface CaseSpec {
  readonly id: CaseId;
  readonly title: string;
  readonly control: string;
  /** The control switched off for the sabotage run; null where it cannot be switched off. */
  readonly sabotage: SabotageMode | null;
}

export const CASE_SPECS: readonly CaseSpec[] = [
  {
    id: 'uploaded-script',
    title: 'Uploaded script',
    control:
      "The edge refuses an uploaded file a browser would run (the upload guard `render_demo_site.py` prints, under Ghost's /content/ prefixes)",
    sabotage: 'no-upload-guard',
  },
  {
    id: 'inline-script',
    title: 'Inline script',
    control:
      "The edge content policy: script-src 'self' plus the theme's derived hashes, no unsafe-inline (render-core `renderEdgeSiteBlock`)",
    sabotage: 'no-csp',
  },
  {
    id: 'cookie-tossing',
    title: 'Cookie tossing from a sibling tenant',
    control:
      'No tenant script runs on the shared domain (the upload guard and the content policy), so a sibling cannot write a cookie the victim tenant is sent',
    sabotage: 'no-csp',
  },
  {
    id: 'portal-host-cookies',
    title: 'Portal __Host- cookies',
    control:
      "The portal's cookies carry the __Host- prefix, so the browser refuses a Domain, a wider Path or an insecure write under that name (portal/apps/src/shell/cookies.ts)",
    sabotage: 'portal-prefix-off',
  },
  {
    id: 'cookie-bomb',
    title: 'Cookie bomb',
    control:
      'No tenant script runs on the shared domain, so a sibling cannot grow the cookie header the victim tenant is sent past what Ghost accepts',
    sabotage: 'no-csp',
  },
  {
    id: 'cross-site-request',
    title: 'Cross-site request',
    control:
      "Ghost's admin API refuses a state-changing request whose Origin is not the tenant's own, whatever cookie the browser sends with it",
    sabotage: 'origin-spoof',
  },
  {
    id: 'theme-script',
    title: 'Theme script',
    control:
      'A tenant cannot serve a theme the platform has not admitted: a hostile theme must not run script on the shared domain (content policy for its inline script; admission for its script files)',
    sabotage: 'no-csp',
  },
];

export function specOf(id: CaseId): CaseSpec {
  const spec = CASE_SPECS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`no case ${id}`);
  return spec;
}
