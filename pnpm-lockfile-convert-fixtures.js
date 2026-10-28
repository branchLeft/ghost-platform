// Fixture files for workflow-pnpm-lockfile-convert.test.js. Held as strings,
// not committed under their real names: a file called package-lock.json or
// pnpm-lock.yaml here would be found by the conversion program on this very
// repository and counted as a package to convert.
//
// Three directories: the root (ms), `a` (isexe 2.0.0 and ms) and `b`
// (isexe 4.0.0, plus a link to `a`). The pnpm-lock.yaml texts are what pnpm
// 11 itself wrote from these package-lock.json files, by the same steps the
// workflow runs.

const lock = (dir, deps, packages) =>
  JSON.stringify(
    {
      name: `fixture-${dir}`,
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: `fixture-${dir}`, version: '1.0.0', ...deps }, ...packages },
    },
    null,
    2
  ) + '\n';

const MS = {
  version: '2.1.3',
  resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
  integrity:
    'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==',
};
const ISEXE_2 = {
  version: '2.0.0',
  resolved: 'https://registry.npmjs.org/isexe/-/isexe-2.0.0.tgz',
  integrity:
    'sha512-RHxMLp9lnKHGHRng9QFhRCMbYAcVpn69smSGcq3f36xjgVVWThj4qqLbTLlq7Ssj8B+fIQ1EuCEGI2lKsyQeIw==',
};
const ISEXE_4 = {
  version: '4.0.0',
  resolved: 'https://registry.npmjs.org/isexe/-/isexe-4.0.0.tgz',
  integrity:
    'sha512-FFUtZMpoZ8RqHS3XeXEmHWLA4thH+ZxCv2lOiPIn1Xc7CxrqhWzNSDzD+/chS/zbYezmiwWLdQC09JdQKmthOw==',
};

const HEADER = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

`;

const ISEXE_2_PKG = `  isexe@2.0.0:
    resolution: {integrity: ${ISEXE_2.integrity}}
`;
const ISEXE_4_PKG = `  isexe@4.0.0:
    resolution: {integrity: ${ISEXE_4.integrity}}
    engines: {node: '>=20'}
`;
const MS_PKG = `  ms@2.1.3:
    resolution: {integrity: ${MS.integrity}}
`;

const ROOT_IMPORTER = `  .:
    devDependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3

`;
const A_IMPORTER = `  .:
    dependencies:
      isexe:
        specifier: 2.0.0
        version: 2.0.0
      ms:
        specifier: 2.1.3
        version: 2.1.3

`;
const B_IMPORTER_FINAL = `  .:
    dependencies:
      fixture-a:
        specifier: workspace:*
        version: link:../a
      isexe:
        specifier: 4.0.0
        version: 4.0.0

`;
const B_IMPORTER_IMPORTED = `  .:
    dependencies:
      fixture-a:
        specifier: file:../a
        version: file:../a
      isexe:
        specifier: 4.0.0
        version: 4.0.0

`;

export const CHECKOUT = {
  'package.json':
    '{"name":"fixture-root","version":"0.0.0","private":true,"devDependencies":{"ms":"2.1.3"}}\n',
  'package-lock.json': lock(
    'root',
    { devDependencies: { ms: '2.1.3' } },
    { 'node_modules/ms': { ...MS, dev: true } }
  ),
  'a/package.json':
    '{"name":"fixture-a","version":"1.0.0","private":true,"dependencies":{"isexe":"2.0.0","ms":"2.1.3"}}\n',
  'a/package-lock.json': lock(
    'a',
    { dependencies: { isexe: '2.0.0', ms: '2.1.3' } },
    { 'node_modules/isexe': ISEXE_2, 'node_modules/ms': MS }
  ),
  'b/package.json':
    '{"name":"fixture-b","version":"1.0.0","private":true,"dependencies":{"fixture-a":"workspace:*","isexe":"4.0.0"}}\n',
  'b/package-lock.json': lock(
    'b',
    { dependencies: { 'fixture-a': 'file:../a', isexe: '4.0.0' } },
    {
      '../a': {
        name: 'fixture-a',
        version: '1.0.0',
        dependencies: { isexe: '2.0.0', ms: '2.1.3' },
      },
      'node_modules/fixture-a': { resolved: '../a', link: true },
      'node_modules/isexe': ISEXE_4,
    }
  ),
  'pnpm-workspace.yaml': 'packages:\n  - a\n  - b\nsharedWorkspaceLockfile: false\n',
};

export const FINAL = {
  'pnpm-lock.yaml': `${HEADER}${ROOT_IMPORTER}packages:\n\n${MS_PKG}\nsnapshots:\n\n  ms@2.1.3: {}\n`,
  'a/pnpm-lock.yaml': `${HEADER}${A_IMPORTER}packages:\n\n${ISEXE_2_PKG}\n${MS_PKG}\nsnapshots:\n\n  isexe@2.0.0: {}\n\n  ms@2.1.3: {}\n`,
  'b/pnpm-lock.yaml': `${HEADER}${B_IMPORTER_FINAL}packages:\n\n${ISEXE_4_PKG}\nsnapshots:\n\n  isexe@4.0.0: {}\n`,
};

export const IMPORTED = {
  'pnpm-lock.yaml': FINAL['pnpm-lock.yaml'],
  'a/pnpm-lock.yaml': FINAL['a/pnpm-lock.yaml'],
  'b/pnpm-lock.yaml': `${HEADER}${B_IMPORTER_IMPORTED}packages:

  fixture-a@file:../a:
    resolution: {directory: ../a, type: directory}

${ISEXE_2_PKG}
${ISEXE_4_PKG}
${MS_PKG}
snapshots:

  fixture-a@file:../a:
    dependencies:
      isexe: 2.0.0
      ms: 2.1.3

  isexe@2.0.0: {}

  isexe@4.0.0: {}

  ms@2.1.3: {}
`,
};
