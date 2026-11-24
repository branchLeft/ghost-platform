import {
  FEDERATION_FIELD,
  parseTenantKind,
  type TenantDb,
  type TenantKind,
  type TenantScope,
} from 'ghost-platform-portal-data/tenant';

/**
 * The federation settings page for one signed-in tenant. A real tenant sees one
 * switch and a save; a demo slot sees a notice and no form. Every visible
 * string is an ALL_CAPS placeholder: the wording is the owner's.
 */
export function renderFederation(kind: TenantKind, enabled: boolean): string {
  if (parseTenantKind(kind) !== 'REAL') {
    return '<h1>FEDERATION_TITLE</h1><p>DEMO_NO_FEDERATION_SETTING</p>';
  }
  const checked = enabled ? ' checked' : '';
  return (
    '<h1>FEDERATION_TITLE</h1>' +
    `<p>${enabled ? 'FEDERATION_CURRENTLY_ON' : 'FEDERATION_CURRENTLY_OFF'}</p>` +
    '<form method="post" action="/federation/save">' +
    `<label><input type="checkbox" name="${FEDERATION_FIELD}" value="1"${checked}> FEDERATION_LABEL_ON</label>` +
    '<button type="submit">SAVE_SETTINGS</button></form>'
  );
}

/** The page body. An unknown kind throws; it never falls through to a demo notice. */
export async function federationBody(scope: TenantScope, db: TenantDb): Promise<string> {
  const kind = await db.ownKind(scope);
  const enabled = kind === 'REAL' ? await db.ownFederation(scope) : false;
  return renderFederation(kind, enabled);
}
