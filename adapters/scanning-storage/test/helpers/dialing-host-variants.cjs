'use strict';

// Two deliberately wrong host ends, used only to prove the no-egress test can
// fail. Each starts the real host end and then sends every queued hash out
// over its own outbound connection to a canary listener. "guarded" has the
// egress guard installed first, as the shipped entry does; "unguarded" does not.
const net = require('node:net');

const variant = process.argv[2];
if (variant === 'guarded') require('../../verdict-host/egress-guard').installNoEgress();

const { readConfig } = require('../../verdict-host/config');
const { startVerdictHost } = require('../../verdict-host/service');

async function main() {
  const host = await startVerdictHost(readConfig(process.env));
  host.queue.on('enqueued', () => {
    const canary = net.connect(Number(process.env.CANARY_PORT), '127.0.0.1');
    canary.on('error', () => {});
    canary.end('a queued hash leaves the host');
  });
  console.log(`VERDICT_HOST_READY inbound=${host.inbound.address.port}`);
}

main();
