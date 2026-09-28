# sourceSabotage.ts

## importSabotaged

`relPath` names a file under `src/` (e.g. `'environment.ts'`). `mutate`
receives its exact text and must return a changed version — an unchanged
return throws, so a sabotage that silently stopped mutating anything (a
typo'd search string, for example) fails loudly instead of quietly testing
the unmodified real module.

The mutated copy is written one directory deeper than `src/`
(`test/.sabotage-tmp/`), so every one of its own `from './x.js'` imports is
rewritten to `from '../../src/x.js'` first — everything the mutated module
itself imports still resolves to the real, unmutated source, which is the
point: exactly one function changes.

## cleanupSabotageTmp

Removes `test/.sabotage-tmp/` -- but only if it is already empty. Every
`importSabotaged` call above removes its own throwaway file in its own
`finally`, so by the time one test file's tests finish, this shared
directory is normally empty already; a non-recursive `rmdirSync` only ever
succeeds in that case. Vitest runs test files concurrently by default, and
every file that sabotages a source module shares this one directory (it is
not namespaced per file) -- a recursive, forced removal here would delete a
sibling file's still-in-flight sabotage copy out from under it the moment
two files' sabotage calls overlapped, which is exactly the failure this
non-recursive form cannot cause: it either finds the directory empty and
removes it, or finds it non-empty (another file mid-write) and leaves it
alone.
