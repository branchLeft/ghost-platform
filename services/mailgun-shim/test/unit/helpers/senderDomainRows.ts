/**
 * Sender strings for the hostname pins, built from the lists below so a new
 * delimiter is one entry; shared by the gate test and both routes' tests.
 */

/** Characters that end the host part of a URL. */
export const URL_DELIMITERS = ['#', '/', '?', '\\'] as const;

/**
 * Whitespace that can sit at the edge of a domain: ASCII space and tab, and
 * two non-ASCII spaces that the address parser keeps rather than drops.
 */
export const DOMAIN_EDGE_WHITESPACE = [' ', '\t', ' ', ' '] as const;

/** Text placed after a delimiter: a name that is not the tenant's. */
export const FOREIGN_SUFFIX = '.other.example';

export interface SenderRow {
  readonly label: string;
  readonly from: string;
}

/** Wraps an address the three ways a From value is written. */
function inThreeShapes(label: string, address: string): SenderRow[] {
  return [
    { label: `${label} (bare)`, from: address },
    { label: `${label} (angle)`, from: `<${address}>` },
    { label: `${label} (display name)`, from: `Alice <${address}>` },
  ];
}

/** Values whose domain is not a hostname: every one must be refused. */
export function nonHostnameRows(tenantDomain: string): SenderRow[] {
  const rows: SenderRow[] = [];
  for (const delimiter of URL_DELIMITERS) {
    const shown = JSON.stringify(delimiter);
    rows.push(
      ...inThreeShapes(
        `delimiter ${shown} then a foreign suffix`,
        `alice@${tenantDomain}${delimiter}${FOREIGN_SUFFIX}`
      ),
      ...inThreeShapes(`delimiter ${shown} at the end`, `alice@${tenantDomain}${delimiter}`)
    );
  }
  for (const space of DOMAIN_EDGE_WHITESPACE) {
    const shown = JSON.stringify(space);
    rows.push(
      ...inThreeShapes(`whitespace ${shown} before the domain`, `alice@${space}${tenantDomain}`)
    );
  }
  return rows;
}

/** Alternates upper and lower case across the letters of a domain. */
export function mixedCase(domain: string): string {
  return [...domain].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase())).join('');
}

/** Values that are the tenant's own domain, written validly: every one must be accepted. */
export function hostnameControlRows(tenantDomain: string): SenderRow[] {
  return [
    { label: 'the domain as registered', from: `alice@${tenantDomain}` },
    { label: 'the domain in upper case', from: `alice@${tenantDomain.toUpperCase()}` },
    { label: 'the domain in mixed case', from: `alice@${mixedCase(tenantDomain)}` },
    { label: 'the domain with a trailing root dot', from: `alice@${tenantDomain}.` },
    ...inThreeShapes('the domain in a display-name shape', `alice@${tenantDomain}`).slice(1),
  ];
}
