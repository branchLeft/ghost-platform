'use strict';

// Runs the real HoldRegistry#hold in its own Node process and kills the
// process, with SIGKILL, partway through writing its sidecar, after the
// bytes are on disk. A crash there is what leaves orphaned bytes behind.
//   before-sidecar: as it makes the sidecar directory, so no sidecar exists.
//   inside-sidecar: with its entry's temp file written but not yet renamed,
//                   so the directory holds only that temp file.
const fs = require('node:fs');
const path = require('node:path');

const { HoldRegistry } = require('../../src/hold.js');
const { digestBytes } = require('../../src/pdq.js');

const [quarantinePath, bytesFile, mode = 'before-sidecar'] = process.argv.slice(2);

// hold.js reaches both through the module-level fs object, so wrapping them
// here is the narrowest point a test can reach. The bytes are written
// through fs/promises, so neither fires before they are on disk.
const realMkdirSync = fs.mkdirSync;
fs.mkdirSync = (target, ...rest) => {
  if (mode === 'before-sidecar' && String(target).endsWith('.holds.json')) {
    process.kill(process.pid, 'SIGKILL');
  }
  return realMkdirSync(target, ...rest);
};
const realFsyncSync = fs.fsyncSync;
fs.fsyncSync = (fd) => {
  if (mode === 'inside-sidecar') process.kill(process.pid, 'SIGKILL');
  return realFsyncSync(fd);
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
