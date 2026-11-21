// Prints Ghost's widget address settings for a tenant on `own-origin` widgets,
// one `key=value` per line, from render-core's own table (the one the tenant
// stack's environment is rendered from), never a copy: so the disposable tenant
// loads Portal, search, comments and the rest from the same addresses a paying
// tenant on `widgets: 'own-origin'` does. Reads PROOF_ORIGIN; run with Node.
import { OWN_ORIGIN_WIDGETS, WIDGET_ASSET_PATH_PREFIX } from '../../render-core/dist/index.js';

const origin = (process.env['PROOF_ORIGIN'] ?? '').replace(/\/+$/, '');
if (origin === '') {
  console.error('render-widgets: PROOF_ORIGIN is required');
  process.exit(2);
}
for (const [key, file] of Object.entries(OWN_ORIGIN_WIDGETS)) {
  console.log(`${key}=${origin}${WIDGET_ASSET_PATH_PREFIX}/${file}`);
}
