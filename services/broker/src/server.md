# server.ts

## loadPlugin

`Renderer`, `AdminApiClient`, `DrainSource` and `ImageLoader` are all
loaded as plugin modules rather than built into this entrypoint, for the
same reason in each case: a fake implementation would silently pass its
own tests while doing nothing real in production. `Renderer` is filled for
real (`plugins/renderCorePlugin.ts`, adapting `render-core`'s own
`render()`), and so is `ImageLoader` (`plugins/dockerImageLoader.ts`,
`docker load` and nothing else). The Admin API call's content is
unspecified by any design document; the drain source depends on the
unbuilt mail spool and an unbuilt "reaper" — both still seams.

This entrypoint loads each from a module path named by its own environment
variable and refuses to start if one is missing *or if its default export
does not have the seam's required function*: a module that loads cleanly
but exports nothing usable must fail exactly as loudly as one that was
never pointed to at all, rather than reaching the handler as `undefined`
and failing obscurely on the first request instead.
