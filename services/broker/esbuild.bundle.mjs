// Produces the artefacts `RUNBOOK-broker-deploy.md`'s install step rsyncs to
// demo1: one self-contained ESM file per entrypoint, each with
// `@branchleft/ghost-platform-render-core` (and this package's own modules)
// inlined. `render-core`'s own package.json says why a bundle rather than a
// plain `npm ci` on the host: "to be published the same way ... no publish
// workflow exists for it yet". Without a registry, a host install would
// otherwise need the whole monorepo checkout staged at the exact relative
// layout `file:../../render-core` resolves against (proven locally: `npm
// ci` here links `node_modules/@branchleft/ghost-platform-render-core` as a
// symlink four directories up) -- fragile to rsync and easy to drift.
// `dist/server.js` (built by `tsc` first, see `package.json`'s `bundle`
// script) is the one entrypoint Node runs directly; the plugin modules are
// bundled separately because `server.ts#loadPlugin` reaches them via a
// runtime `import(modulePath)` of a value read from an environment
// variable, which esbuild cannot inline through -- each therefore needs to
// be independently self-contained.
import { build } from 'esbuild';

const targets = [
  { in: 'dist/server.js', out: 'dist/bundle/broker.mjs' },
  { in: 'dist/plugins/renderCorePlugin.js', out: 'dist/bundle/plugins/renderCorePlugin.mjs' },
  { in: 'dist/plugins/dockerImageLoader.js', out: 'dist/bundle/plugins/dockerImageLoader.mjs' },
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
