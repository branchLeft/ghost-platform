# docker-engine.mjs

## Overview

A minimal Docker Engine API client over the unix socket, with Node's `http`
and nothing else. It exists so the break-glass grant tool can run in a
container that has no `docker` CLI: the container mounts `/var/run/docker.sock`
and this file makes the two calls the tool needs.

## What it calls

| Method | Engine call | Used for |
|---|---|---|
| `listContainers({ labels })` | `GET /containers/json?filters=…` with `status=running` and one `label=key=value` per label | Finding the tenant's running Ghost container by its Compose labels. |
| `exec({ container, cmd, env })` | `POST /containers/{name}/exec`, `POST /exec/{id}/start`, `GET /exec/{id}/json` | Running one inner script in that container, and reading its exit code. |

Nothing else is implemented: no create, start, stop, remove or pull.

## The bound

Every logical call has one bound, `DOCKER_TIMEOUT_MS` (60 seconds). It is a
timer on the whole request, armed before the connection is made: a daemon
that accepts and never answers, or an exec that never ends, ends at the bound
with `EngineTimeoutError` and the socket is destroyed. An exec's three
requests share one bound. It is the same bound the host CLI had.

## What it refuses

- A container name that is not a plain name (`^[A-Za-z0-9][A-Za-z0-9_.-]*$`),
  so a value can never shape another Engine path.
- An exec id that is not hex.
- A response over 4 MiB, a response cut off before its end, an answer that is
  not JSON where JSON is expected, and a stream that is not Docker's
  multiplexed framing.
- A non-2xx answer, reported with the daemon's own message, never with the
  request body: the body carries the script and its env.

## Output

`exec` resolves `{ code, stdout, stderr }`. The multiplexed stream is split
into stdout and stderr, and the code is the exec's own exit code, read after
the stream ends. The caller decides what a non-zero code means.
