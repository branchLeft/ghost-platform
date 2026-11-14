'use strict';

// One side of a cross-process hold/release race, run as its own Node
// process with the real HoldRegistry. It stops at numbered gates and waits
// for the test to open each.
//   releaser: holds the digest, is allowed at once, and pauses at gate 1
//             in the middle of its release: before it gives up its own
//             sidecar entry (pauseAt 'entry'), just before the bytes are
//             moved aside (pauseAt 'before') or just after (pauseAt 'after').
//   holder:   a second registry (another owner, another process) holds the
//             same digest and never gets a verdict.
const fs = require('node:fs');
const path = require('node:path');

const { HoldRegistry } = require('../../src/hold.js');
const { digestBytes } = require('../../src/pdq.js');

const [role, quarantinePath, bytesFile, controlDir, pauseAt] = process.argv.slice(2);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function gate(n) {
  fs.writeFileSync(path.join(controlDir, `${role}.at${n}`), '');
  const go = path.join(controlDir, `${role}.go${n}`);
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(go)) {
    if (Date.now() > deadline) process.exit(3);
    Atomics.wait(sleeper, 0, 0, 5);
  }
}

const ALLOW = { kind: 'media', run: async () => ({ classification: 'no-known-match' }) };
const logger = { error: (message) => process.stderr.write(`${message}\n`) };

async function main() {
  const buffer = fs.readFileSync(bytesFile);
  const digest = digestBytes(buffer);
  const releaser = role === 'releaser';
  const registry = new HoldRegistry({
    checks: releaser ? [ALLOW] : [],
    policy: { decide: () => (releaser ? 'allow' : 'hold') },
    quarantinePath,
    owner: `${role}-owner`,
    computeDigest: digestBytes,
    retryIntervalMs: 1,
    onBeforeHolderRelease: releaser && pauseAt === 'entry' ? () => gate(1) : undefined,
    onBeforeBytesRelease: releaser && pauseAt === 'before' ? () => gate(1) : undefined,
    onBytesMovedAside: releaser && pauseAt === 'after' ? () => gate(1) : undefined,
    logger,
  });

  gate(0);
  await registry.hold(digest, buffer, {
    targetPath: `${role}.png`,
    onAllow: () => {},
    onRefuse: () => {},
  });
  if (releaser) {
    while (registry.isPending(digest)) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  registry.stopAll();
  fs.writeFileSync(path.join(controlDir, `${role}.done`), '');
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack));
  process.exit(1);
});
