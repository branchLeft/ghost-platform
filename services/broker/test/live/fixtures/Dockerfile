# The "host" container for imagePush.live.test.ts: enough to run this
# service's own compiled receiver (Node) and to load/run what it receives
# (the `docker` CLI, talking to the daemon shared over a bind-mounted
# socket -- never a registry). Built once, locally, before the isolated
# no-egress network in the live test even exists; nothing about running a
# container from this image later needs to reach anywhere.
FROM node:22-alpine
RUN apk add --no-cache docker-cli
