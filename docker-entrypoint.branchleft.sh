#!/bin/sh
# branchLeft entrypoint wrapper for Cloud Run.
#
# Cloud Run injects the port to listen on via the $PORT environment variable
# (defaulting to 8080 if unset, per Cloud Run's contract) and requires the
# container to bind all interfaces. Ghost has no native concept of $PORT —
# it reads server.port / server.host through nconf — so this wrapper
# translates Cloud Run's convention into Ghost's own env-var config keys
# (server__port, server__host; see README.md for the full nconf/env-var
# mapping) before handing off to the upstream image's entrypoint.
#
# The upstream entrypoint (docker-entrypoint.sh, shipped by the base
# ghost:6.55.0-alpine image) still needs to run first: it steps down from
# root to the "node" user via gosu, and seeds the (always-empty, since
# Cloud Run has no durable volume) content directory from content.orig on
# every boot — that seeding is what puts the default Casper theme and
# fixture settings in place. We don't reimplement that; we just set env
# vars and exec into it.
set -e

export server__port="${PORT:-2368}"
export server__host="${SERVER_HOST:-0.0.0.0}"

exec docker-entrypoint.sh "$@"
