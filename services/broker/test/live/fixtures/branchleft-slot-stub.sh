#!/bin/sh
# A live-test stand-in for the real, sudoers-enumerated
# /usr/local/sbin/branchleft-slot's `load` verb -- this container has
# neither `sudo` nor that binary (demo-host/provision/render_slot_sudoers.py
# generates the real one's grant; nothing installs the real script itself
# yet). It exists only to prove the argv contract `wrapper.ts`'s `load()`
# sends -- `load <path>`, exactly two arguments, never joined -- against a
# real `docker load` and a real daemon, standing in for whatever
# eventually implements the verb on a real host.
set -e
if [ "$1" != "load" ] || [ -z "$2" ] || [ -n "$3" ]; then
  echo "unsupported invocation: $*" >&2
  exit 1
fi
exec docker load -i "$2"
