#!/bin/sh
# The one way an operator runs the break-glass grant tool on an app host:
# grant, revoke, status or expire, in the pinned Node container with no
# network. Installed root-owned, mode 0700, at /usr/local/sbin/branchleft-break-glass.
# See branchleft-break-glass.md for what is mounted and why.
set -eu

IMAGE='node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb'
TOOL_DIR=/usr/local/lib/branchleft/break-glass
STATE_DIR=/var/lib/branchleft/break-glass-grants
LOG_DIR=/var/log/branchleft
SOCKET=/var/run/docker.sock
TIMER=branchleft-break-glass-expire.timer

# The container cannot ask systemd, so the host answers and the tool refuses
# a grant unless the answer is exactly "active".
if systemctl is-active --quiet "$TIMER"; then
  timer_state=active
else
  timer_state=inactive
fi

exec docker run --rm --pull never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 256m --user 0:0 \
  --label branchleft.component=break-glass-tool \
  --mount "type=bind,source=$TOOL_DIR,target=$TOOL_DIR,readonly" \
  --mount "type=bind,source=$STATE_DIR,target=$STATE_DIR" \
  --mount "type=bind,source=$LOG_DIR,target=$LOG_DIR" \
  --mount "type=bind,source=$SOCKET,target=$SOCKET" \
  -e "BL_EXPIRE_TIMER_STATE=$timer_state" \
  "$IMAGE" node "$TOOL_DIR/break-glass-grant.mjs" "$@"
