// The Caddyfile for the local edge: both tenants behind one listener, each with
// the header and the upload refusal the shared domain's edge is meant to carry.
// Pure, so a unit test can read what it renders. The upload refusal itself is
// not written here: it is printed by the demo edge's own renderer and mounted
// in, so the suite attacks the rule that ships and not a copy of it.

export interface EdgeTenant {
  readonly host: string;
  readonly upstream: string;
  /** The Content-Security-Policy value, or null for none. */
  readonly csp: string | null;
  /** When set, the edge overwrites the request's Origin with this value (the sabotage). */
  readonly spoofOrigin: string | null;
}

export class EdgeRenderError extends Error {}

// Characters that would end a quoted Caddyfile string early or start a placeholder.
const UNSAFE_IN_QUOTES = /["\\\r\n{}`]/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const UPSTREAM = /^[a-z0-9][a-z0-9-]*:[0-9]{1,5}$/;

export const GUARD_MOUNT = '/etc/caddy/upload-guard.caddy';

export function renderCaddyfile(tenants: readonly EdgeTenant[]): string {
  const lines: string[] = [
    '{',
    '\tauto_https off',
    '\tadmin off',
    '}',
    '',
    ':8080 {',
    '\thandle_path /bl-assets/* {',
    '\t\troot * /srv/bl-assets',
    '\t\tfile_server',
    '\t}',
    '',
  ];
  tenants.forEach((t, i) => {
    if (!HOST.test(t.host))
      throw new EdgeRenderError(`host ${JSON.stringify(t.host)} is not a plain hostname`);
    if (!UPSTREAM.test(t.upstream))
      throw new EdgeRenderError(`upstream ${JSON.stringify(t.upstream)} is not name:port`);
    for (const value of [t.csp, t.spoofOrigin]) {
      if (value !== null && UNSAFE_IN_QUOTES.test(value)) {
        throw new EdgeRenderError(
          'a header value carries a character that escapes a quoted string'
        );
      }
    }
    lines.push(
      `\t@tenant${i} host ${t.host}`,
      `\thandle @tenant${i} {`,
      '\t\theader X-Content-Type-Options "nosniff"'
    );
    if (t.csp !== null) lines.push(`\t\theader Content-Security-Policy "${t.csp}"`);
    lines.push('\t\troute {', `\t\t\timport ${GUARD_MOUNT}`);
    if (t.spoofOrigin !== null) lines.push(`\t\t\trequest_header Origin "${t.spoofOrigin}"`);
    lines.push(`\t\t\treverse_proxy ${t.upstream}`, '\t\t}', '\t}', '');
  });
  lines.push('\thandle {', '\t\trespond "no such tenant" 404', '\t}', '}', '');
  return lines.join('\n');
}
