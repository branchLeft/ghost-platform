// Prints the host's mail-spool Compose file, rendered by render-core exactly
// as the delivery runbook renders it. Needs `npm run build` in render-core.
// Usage: node scripts/render-mail-spool-compose.mjs <image@sha256:...> <drainPort> <uid>...
import { renderMailSpoolStack } from '../render-core/dist/index.js';

const [image, drainPort, ...uids] = process.argv.slice(2);
if (!image || !drainPort || uids.length === 0) {
  console.error('usage: render-mail-spool-compose.mjs <image> <drainPort> <uid>...');
  process.exit(2);
}
process.stdout.write(
  renderMailSpoolStack({
    image,
    drainPort: Number(drainPort),
    uids: uids.map(Number),
  })
);
