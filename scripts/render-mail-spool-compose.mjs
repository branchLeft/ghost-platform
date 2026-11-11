// Prints the host's mail-spool Compose file, rendered by render-core exactly
// as the delivery runbook renders it. Needs `pnpm run build` in render-core.
// Usage: node scripts/render-mail-spool-compose.mjs [--mails <specs.json>] <image@sha256:...> <drainPort> <uid>...
//
// --mails names a JSON array with one mail spec per descriptor on the host
// (the descriptor's `mail`, e.g. `{"route": {"primary": "sweego", "sweegoAllowance": 100}}`).
// The spool renders SHIM_DRAIN_OUTCOMES when one of them routes through Sweego.
// Without --mails the host has no mail specs, so no outcomes line is rendered.
import { readFileSync } from 'node:fs';
import {
  MAIL_ROUTES,
  mailSpoolNeedsDrainOutcomes,
  renderMailSpoolStack,
} from '../render-core/dist/index.js';

function readMailSpecs(path) {
  const specs = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(specs)) throw new Error('--mails must name a JSON array of mail specs');
  for (const spec of specs) {
    if (typeof spec !== 'object' || spec === null) throw new Error('a mail spec must be an object');
    if ('route' in spec && !MAIL_ROUTES.includes(spec.route?.primary)) {
      throw new Error(`a mail spec's route.primary must be one of ${MAIL_ROUTES.join(', ')}`);
    }
  }
  return specs;
}

const usage =
  'usage: render-mail-spool-compose.mjs [--mails <specs.json>] <image> <drainPort> <uid>...';
let argv = process.argv.slice(2);
let mails = [];
if (argv[0] === '--mails') {
  if (argv[1] === undefined) {
    console.error(usage);
    process.exit(2);
  }
  try {
    mails = readMailSpecs(argv[1]);
  } catch (error) {
    console.error(`render-mail-spool-compose.mjs: ${error.message}`);
    process.exit(2);
  }
  argv = argv.slice(2);
}

const [image, drainPort, ...uids] = argv;
if (!image || !drainPort || uids.length === 0) {
  console.error(usage);
  process.exit(2);
}
process.stdout.write(
  renderMailSpoolStack({
    image,
    drainPort: Number(drainPort),
    uids: uids.map(Number),
    drainOutcomes: mailSpoolNeedsDrainOutcomes(mails),
  })
);
