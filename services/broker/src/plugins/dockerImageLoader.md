# dockerImageLoader.ts

## dockerImageLoader

The `ImageLoader` seam (`../imagePush.ts`), filled — the plugin
`server.ts` loads via `BROKER_IMAGE_LOADER_MODULE` in a real deploy.

Never calls `docker` itself. The broker's unprivileged user gets root for
exactly the sudoers-enumerated verbs a forced-command wrapper defines
(`start`/`stop`/`reset`, and now `load`) — holding the Docker socket
directly would be a wider, and root-equivalent, grant than that. This
module goes through the same `SlotWrapper` (`../wrapper.ts`) `app.ts`
already uses for `start`/`stop`/`reset`, so there is exactly one place in
the service that ever builds a privileged invocation's argv, not two that
could drift — an audit for "does anything here ever shell out to `docker`"
has exactly one file to read either way, and it is not this one.

The sudoers `load` rule grants exactly one literal invocation: the wrapper
path, then `load` and the one fixed tar path `imagePush.ts` always stages a
verified push at. That path is not sudoers-enumerable the way a
slot+colour+verb combination is (it names a file, not one of a finite set
of literals), so the sudoers layer cannot itself refuse a different path
the way it refuses a fourth argument on `reset`. This module is the second,
structural layer: it resolves the path it is given with `realpath` —
through any symlink, collapsing any `..` — and refuses to go anywhere near
the wrapper unless the resolved path lives inside the resolved fixed
directory. A tar that fails this check is refused before a single
privileged process is spawned.

Requires the tar to have been produced with `docker save <content digest>`,
never `docker save <repo:tag>` — see the error this throws when
`docker load`'s output carries a repo:tag instead of a bare image ID, which
is the shape a tag-based save produces and this loader refuses to treat as
a match for "runs it by digest only".
