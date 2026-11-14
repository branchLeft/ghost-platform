# noPerFileBuild.test.ts

## Why a test may not build

The server-startup tests spawn the compiled `dist/server.js`, and
`store.preDrainMigration.test.ts` spawns `dist/store.js` and
`dist/migrate.js`. vitest runs test files in parallel, so a file that runs
`pnpm run build` itself rewrites `dist/` while another file is starting a
process from it. The reader then sees a half-emitted module (CI showed
`The requested module './smtpFrontDoor.js' does not provide an export named
'DEFAULT_ALLOWED_SOURCE_CIDRS'`). `test/globalSetup.ts` builds `dist/` once,
before any file runs; that is the only place a build may happen.

`test/globalSetup.ts` fixed the five server-startup files, and
`store.preDrainMigration.test.ts` kept three builds of its own. Nothing
stopped the next test file doing the same, so this reads every `.ts` and
`.mjs` file under `test/` and fails on any child-process call whose
arguments run `tsc` or a `build` script, other than `globalSetup.ts`.

The first case checks the detector flags each way a build is spelled, so a
pattern that matches nothing cannot pass the second. The third checks
`globalSetup.ts` still builds: without it the guard would pass while no
build ran at all.
