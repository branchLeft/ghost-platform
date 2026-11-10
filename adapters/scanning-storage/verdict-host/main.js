'use strict';

// The host end's process entry. The egress guard is installed before anything
// else is loaded, so no later module can make a connection first.
const { installNoEgress } = require('./egress-guard');

const egress = installNoEgress();

const { readConfig } = require('./config');
const { startVerdictHost } = require('./service');

async function main() {
  const config = readConfig(process.env);
  const host = await startVerdictHost(config, { egressRefused: egress.refusedCount });
  const { address, port } = host.inbound.address;
  console.log(`VERDICT_HOST_READY inbound=${address}:${port}`);
  const stop = () => {
    host.stop().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((err) => {
  // A host end that cannot start must not half-run: exit non-zero so the
  // supervisor shows it, and the decorator holds every upload meanwhile.
  console.error(`VERDICT_HOST_START_FAILED ${err.message}`);
  process.exit(1);
});
