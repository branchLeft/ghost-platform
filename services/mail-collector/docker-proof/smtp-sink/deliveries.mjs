// Prints the sink's delivery log as a JSON array -- run via
// `docker compose exec smtp-sink node deliveries.mjs`, the same
// `docker compose exec` pattern services/mailgun-shim's own proof uses to
// read state that is never published to the host.
import { existsSync, readFileSync } from 'node:fs';

const LOG_PATH = '/data/deliveries.ndjson';
if (!existsSync(LOG_PATH)) {
  console.log('[]');
} else {
  const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  console.log(JSON.stringify(lines.map((l) => JSON.parse(l))));
}
