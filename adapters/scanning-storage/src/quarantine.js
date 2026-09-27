'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Refused bytes are named by digest, never by the uploader's filename: a
// filename cannot be chosen to collide with, or overwrite, another tenant's
// quarantined object. Writing the same digest twice writes the same bytes
// twice, which is a no-op in every way that matters.
async function quarantineBytes(quarantinePath, digest, buffer) {
  await fs.mkdir(quarantinePath, { recursive: true });
  const target = path.join(quarantinePath, digest);
  await fs.writeFile(target, buffer);
  return target;
}

module.exports = { quarantineBytes };
