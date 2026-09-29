import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LITERAL_ROUTES, STATUS_ROUTE } from '../../src/app.js';

const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

interface OpenApiDocument {
  readonly paths: Record<string, Record<string, unknown>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

/**
 * Every `(METHOD, path)` pair the spec declares, uppercased and with its
 * path exactly as written (`/status/{slot}`, not decoded or normalised) --
 * the same shape `app.ts`'s own `LITERAL_ROUTES`/`STATUS_ROUTE` use, so the
 * two sides compare directly with no reformatting on either side to hide a
 * real mismatch.
 */
function specRoutes(doc: OpenApiDocument): Set<string> {
  const routes = new Set<string>();
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const method of Object.keys(operations)) {
      if (!HTTP_METHODS.includes(method)) continue; // skips $ref/parameters/summary/description siblings
      routes.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return routes;
}

function appRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const route of LITERAL_ROUTES) routes.add(`${route.method} ${route.path}`);
  routes.add(`${STATUS_ROUTE.method} ${STATUS_ROUTE.path}`);
  return routes;
}

describe('openapi.yaml matches what the broker actually dispatches', () => {
  it('has no route the app serves but the spec omits, and no route the spec declares but the app never serves', async () => {
    const raw = await readFile(OPENAPI_PATH, 'utf8');
    const doc = parse(raw) as OpenApiDocument;

    const fromSpec = specRoutes(doc);
    const fromApp = appRoutes();

    const missingFromSpec = [...fromApp].filter((route) => !fromSpec.has(route));
    const missingFromApp = [...fromSpec].filter((route) => !fromApp.has(route));

    expect(missingFromSpec).toEqual([]);
    expect(missingFromApp).toEqual([]);
  });

  it('the spec declares at least the routes this test knows about (a stale fixture can’t report a false green)', () => {
    // Sabotage check for this test's own control case (all-clear-needs-a-
    // control-case): if LITERAL_ROUTES/STATUS_ROUTE were ever accidentally
    // emptied, the assertions above would vacuously pass. Pin a lower bound
    // so that failure mode is caught here instead.
    expect(LITERAL_ROUTES.length).toBeGreaterThanOrEqual(5);
  });
});
