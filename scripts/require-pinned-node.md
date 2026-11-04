# require-pinned-node.sh

Runs a command only under the Node that `.nvmrc` pins, compared by major version.

`scripts/require-pinned-node.sh <command> [args...]`

The prettier and eslint commit hooks run through it. pnpm crashes under an older Node
(`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` on Node 20) before it reaches the tool, so a hook under the
wrong Node died with a stack trace that did not say what was wrong, and invited `--no-verify`. Under the
wrong Node the script exits 1 with one line on stderr that names the Node the repository needs and the
one it found. It does not select a Node: choosing one (nvm, fnm, PATH) is the caller's.

`require-pinned-node.test.js` at the repository root proves it with a fake `node` on PATH, and that both
hooks in `.pre-commit-config.yaml` go through it.
