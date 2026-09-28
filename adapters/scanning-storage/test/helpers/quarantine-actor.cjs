'use strict';

// One side of a cross-process seal/release race, run as its own Node
// process. It stops at numbered gates and waits for the test to open each.
const fs = require('node:fs');
const path = require('node:path');

const { releaseBytes, sealRefusal } = require('../../src/quarantine.js');
const { digestBytes } = require('../../src/pdq.js');

const [role, quarantinePath, digest, bytesFile, controlDir] = process.argv.slice(2);
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

async function main() {
  gate(0);
  if (role === 'release') {
    releaseBytes(quarantinePath, digest, { onMovedAside: () => gate(1) });
  } else {
    await sealRefusal(
      quarantinePath,
      digest,
      fs.readFileSync(bytesFile),
      { classification: 'csam', matchType: 'exact' },
      digestBytes,
      { onRecordWritten: () => gate(1) }
    );
  }
  fs.writeFileSync(path.join(controlDir, `${role}.done`), '');
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack));
  process.exit(1);
});
