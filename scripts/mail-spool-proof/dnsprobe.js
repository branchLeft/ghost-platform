// Run inside a container: `node - NAME < dnsprobe.js`. Exit 0 only if NAME
// resolves.
require('node:dns')
  .promises.lookup(process.argv[2])
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
