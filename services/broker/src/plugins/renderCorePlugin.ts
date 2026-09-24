/**
 * The `Renderer` seam (`render.ts`), filled — the plugin `server.ts` loads
 * via `BROKER_RENDERER_MODULE` in a real deploy.
 *
 * `render.ts`'s own doc comment named this exactly: "the descriptor-to-
 * artefacts renderer is workspace#1183's unbuilt 'seven artefacts, pure'
 * package" — this module is the adapter now that it is built. It carries
 * no rendering logic of its own; every artefact comes from `render-core`'s
 * `render()`, already a dependency of this service (`file:../../render-core`
 * in `package.json`, used today for `TenantDescriptor`, `validate()` and
 * `hashIdOf`).
 *
 * `zones` is read from the same two environment variables `config.ts`
 * reads for the rest of the broker (`BROKER_DEMO_ZONE`, `BROKER_PLATFORM_ZONE`,
 * `BROKER_OWNED_DOMAINS`) — this module has no config object of its own to
 * receive them through, because `loadPlugin` only ever calls `import()` on
 * the module path and reads its default export; matching `config.ts`'s own
 * env var names, rather than inventing new ones, is what keeps the two from
 * ever silently disagreeing about which zone a hostname belongs to.
 *
 * Deliberately thin: `descriptor` reaching `render()` has already passed
 * `validate()` in `app.ts`'s `handleReconcile` (this seam is only ever
 * called after that), so this module adds no validation of its own — it
 * would be a second, divergent copy of a check `validate()` already owns.
 */

import { render, type ZoneConfig } from '@branchleft/ghost-platform-render-core';
import type { Renderer } from '../render.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. renderCorePlugin.ts reads the same zone configuration ` +
        `config.ts does, under the same variable names.`
    );
  }
  return value;
}

/**
 * Not module-top-level: reading `process.env` at import time would freeze
 * whatever was set at that instant, which in a test that sets environment
 * variables before spawning a fresh process is fine, but is also a subtler
 * contract than "reads the environment the request runs under" needs to be.
 * Called once per `render()`, which is cheap (three string reads) next to
 * everything else `render()` itself does.
 */
function zonesFromEnv(): ZoneConfig {
  return {
    demoZone: requireEnv('BROKER_DEMO_ZONE'),
    platformZone: requireEnv('BROKER_PLATFORM_ZONE'),
    ownedDomains: requireEnv('BROKER_OWNED_DOMAINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const renderer: Renderer = {
  async render(descriptor) {
    return render(descriptor, zonesFromEnv());
  },
};

export default renderer;
