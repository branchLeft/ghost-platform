# Demo host mail spool CI path filter test

`.github/workflows/demo-host-mail-spool-ci.yml` starts only when a diff touches a path in its `paths:` filter. A filter that lists one source file while the job builds all of render-core and mounts all of `demo-host/provision` lets a change to any other input merge without the job running.

`test_demo_host_mail_spool_ci_paths.py` derives the job's real inputs and fails for:

- an input outside the filter, for either event;
- the `push` and `pull_request` lists differing;
- a filter entry that matches no tracked file (a rename leaves one behind silently).

## Where the inputs come from

- **render-core build:** the `include` list of `render-core/tsconfig.build.json`, its relative `extends`, and the import closure of `src/index.ts`, which must stay inside `src/`. Markdown under `src/` is not compiled, so it is not an input.
- **What the workflow's setup steps read:** `node-version-file`, `cache-dependency-path`, and the root `package.json` that `pnpm/action-setup` reads its version from. `render-core/package.json` and the `.npmrc` beside it, which `pnpm install` reads from its working directory.
- **Scripts the workflow runs:** each one, plus every `$HERE` path a shell script reads, directories expanded to the files under them (the proof mounts the whole of `demo-host/provision` and copies the whole of `scripts/mail-spool-proof`).
- **Files a `.mjs` input joins onto its own directory:** the compose test reads render-core's golden file that way.

Comments in the workflow are ignored. The test reads the tree and the workflow only: no network, no docker. The sabotage cases drop an entry, add a stale one, and let the two events differ; each must go red.

It runs in `repo-tooling-ci.yml`, which has no paths filter. A new input to the spool job is added to the filter, and the test says so when it is not.
