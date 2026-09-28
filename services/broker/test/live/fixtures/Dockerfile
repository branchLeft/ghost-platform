# The "host" container for imagePush.live.test.ts: enough to run this
# service's own compiled receiver (Node), the real root-side wrapper
# (`demo-host/provision/branchleft_slot.py`, mounted in by the test) that
# actually calls `docker load`, and the `docker` CLI itself, talking to the
# daemon shared over a bind-mounted socket -- never a registry. Built once,
# locally, before the isolated no-egress network in the live test even
# exists; nothing about running a container from this image later needs to
# reach anywhere.
FROM node:22-alpine
RUN apk add --no-cache docker-cli python3

# This container has no `sudo` and runs everything as its one built-in
# `root`, so there is no separate unprivileged "broker" account here the
# way the sudoers CI job (`demo-host-sudoers-ci.yml`) creates a real one --
# aliasing the name to uid 0 lets the real wrapper's own
# `pwd.getpwnam("broker")` ownership check see a name that resolves to
# whichever uid actually staged the file (root, in this container), rather
# than this test needing its own copy of that check to skip. The check
# itself still runs unmodified; only the account this container calls it by
# is a root alias, not a code change.
RUN echo "broker:x:0:0:broker (root alias for this test image only):/root:/bin/sh" >> /etc/passwd

# The one fixed path `render_slot_sudoers.IMAGE_LOAD_INVOCATION` and
# `branchleft_slot.IMAGE_LOAD_PATH` both name -- baked into the image so it
# exists before `hostReceiver.mjs` ever stages a push there.
RUN mkdir -p /var/lib/branchleft-broker/image-tmp
