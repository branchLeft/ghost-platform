/**
 * The `Renderer` seam (`render.ts`), filled — the plugin `server.ts` loads
 * via `BROKER_RENDERER_MODULE` in a real deploy. Carries no rendering
 * logic of its own, and no validation: `descriptor` reaching `render()`
 * has already passed `validate()` in `app.ts`'s `handleReconcile`.
 * See renderCorePlugin.md#rendercoreplugin.
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
