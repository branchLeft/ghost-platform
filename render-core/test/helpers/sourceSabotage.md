# sourceSabotage.ts

## importSabotaged

`relPath` names a file under `src/` (e.g. `'environment.ts'`). `mutate`
receives its exact text and must return a changed version — an unchanged
return throws, so a sabotage that silently stopped mutating anything (a
typo'd search string, for example) fails loudly instead of quietly testing
the unmodified real module.

The mutated copy is written one directory deeper than `src/`
(a fresh `test/.sabotage-XXXXXX/` per call, removed in the same call's
`finally`), so every one of its own `from './x.js'` imports is
rewritten to `from '../../src/x.js'` first — everything the mutated module
itself imports still resolves to the real, unmutated source, which is the
point: exactly one function changes.

## cleanupSabotageTmp

Removes the pre-namespacing `test/.sabotage-tmp/`, but only if it is empty.
Nothing creates that directory any more: each `importSabotaged` call owns a
fresh `test/.sabotage-XXXXXX/` and removes only that directory, so no call can
delete another file's in-flight copy. The function is kept so existing
callers stay valid; a non-recursive `rmdirSync` on a missing or non-empty
directory is harmless. Regression: `test/sourceSabotage.race.test.ts`.
