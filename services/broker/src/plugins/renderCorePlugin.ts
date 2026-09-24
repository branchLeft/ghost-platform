/**
 * The `Renderer` seam (`render.ts`), filled — the plugin `server.ts` loads
 * via `BROKER_RENDERER_MODULE` in a real deploy.
 *
 * It carries no rendering logic of its own; every artefact comes from
 * `render-core`'s `render()`, already a dependency of this service
 * (`file:../../render-core` in `package.json`, used today for
 * `TenantDescriptor`, `validate()` and `hashIdOf`).
 *
 * `zones` comes from `config.ts#zonesFromEnv` — the exact function
 * `loadConfig` itself calls for `BrokerConfig.zones` — rather than a
 * second copy of the same three environment variables kept here. This
 * module still has no `BrokerConfig` to receive `zones` through directly
 * (`loadPlugin` only ever calls `import()` on the module path and reads
 * its default export), so it calls the shared parser itself; the point of
 * sharing the function is that there is exactly one implementation to
 * drift, not zero reads of `process.env`.
 *
 * Deliberately thin otherwise: `descriptor` reaching `render()` has already
 * passed `validate()` in `app.ts`'s `handleReconcile` (this seam is only
 * ever called after that), so this module adds no validation of its own —
 * it would be a second, divergent copy of a check `validate()` already
 * owns.
 */

import { render } from '@branchleft/ghost-platform-render-core';
import { zonesFromEnv } from '../config.js';
import type { Renderer } from '../render.js';

const renderer: Renderer = {
  async render(descriptor) {
    return render(descriptor, zonesFromEnv(process.env));
  },
};

export default renderer;
