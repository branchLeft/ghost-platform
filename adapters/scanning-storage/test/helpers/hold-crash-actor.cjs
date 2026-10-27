'use strict';

// Runs the real HoldRegistry#hold in its own Node process and kills the
// process, with SIGKILL, at the moment the hold starts writing its sidecar:
// after the bytes are on disk, before any sidecar exists. A crash in that
// gap is what leaves orphaned bytes behind.
const fs = require('node:fs');
const path = require('node:path');

const { HoldRegistry } = require('../../src/hold.js');
const { digestBytes } = require('../../src/pdq.js');

const [quarantinePath, bytesFile] = process.argv.slice(2);

// The sidecar is written through a temp file named `.<digest>.holds.json.*`
// opened with the module-level fs object, so wrapping openSync is the
// narrowest point before the sidecar write that a test can reach.
const realOpenSync = fs.openSync;
fs.openSync = (target, ...rest) => {
  if (path.basename(String(target)).startsWith('.') && String(target).includes('.holds.json.')) {
    process.kill(process.pid, 'SIGKILL');
  }
  return realOpenSync(target, ...rest);
};

const buffer = fs.readFileSync(bytesFile);
const registry = new HoldRegistry({
  checks: [],
  policy: { decide: () => 'hold' },
  quarantinePath,
  owner: 'CrashActorStorage:/synthetic',
  computeDigest: digestBytes,
  logger: { error: () => {} },
});

registry
  .hold(digestBytes(buffer), buffer, {
    targetPath: 'synthetic.png',
    onAllow: () => {},
    onRefuse: () => {},
  })
  .then(() => process.exit(4))
  .catch((err) => {
    process.stderr.write(String(err && err.stack));
    process.exit(1);
  });
