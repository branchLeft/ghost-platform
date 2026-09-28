# serverStartupCleanup.test.ts

## The scheduler is wired

`test/unit/cleanup.test.ts` proves the scheduler MODULE works — it
unit-tests `startCleanupScheduler` in isolation. That proves nothing
about whether `server.ts` actually calls it: a stub swapped in for the
real scheduler in `server.ts`, with the import kept referenced so
`tsc`'s unused-import check stays quiet, would leave the whole rest of
the suite green — the module can be perfectly correct and entirely
unwired at the same time.

This spawns the real entrypoint against a real file-backed store
seeded, before startup, with a batch that finished 31 days ago (past
the 30-day retention `cleanup.ts` documents) plus a CONTROL batch that
finished only 1 day ago. If `server.ts` genuinely starts the
scheduler, the old batch is gone and the recent one survives by the
time the server has logged "listening" (the scheduler's own first
tick runs synchronously, before `app.listen`, in `server.ts`'s current
ordering) — checked by opening the same sqlite file directly, not
through any endpoint the server itself controls.
