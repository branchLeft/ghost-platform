// Produces the self-contained ESM artefacts RUNBOOK-broker-deploy.md's
// install step ships (why a bundle rather than `npm ci` on the host: see
// "Runtime: a bundled single file" in that runbook).
import { build } from 'esbuild';

const targets = [
  { in: 'dist/server.js', out: 'dist/bundle/broker.mjs' },
  { in: 'dist/plugins/renderCorePlugin.js', out: 'dist/bundle/plugins/renderCorePlugin.mjs' },
  { in: 'dist/plugins/dockerImageLoader.js', out: 'dist/bundle/plugins/dockerImageLoader.mjs' },
  { in: 'dist/plugins/refusingAdminApi.js', out: 'dist/bundle/plugins/refusingAdminApi.mjs' },
  {
    in: 'dist/plugins/refusingDrainSource.js',
    out: 'dist/bundle/plugins/refusingDrainSource.mjs',
  },
];

for (const target of targets) {
  await build({
    entryPoints: [target.in],
    outfile: target.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Node builtins are never bundled (esbuild leaves `node:*` imports
    // alone by default under platform: 'node'); nothing else stays
    // external, so the output has no `node_modules` dependency at all.
    sourcemap: false,
    logLevel: 'info',
  });
}
