#!/usr/bin/python3 -I
# The one way an operator runs the break-glass grant tool on an app host:
# grant, revoke, provision, status or expire, in the pinned Node container with no
# network. Installed root-owned, mode 0700, at /usr/local/sbin/branchleft-break-glass.
# See branchleft-break-glass.md for what is mounted and why.
import os
import subprocess
import sys

IMAGE = 'node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb'
TOOL_DIR = '/usr/local/lib/branchleft/break-glass'
STATE_DIR = '/var/lib/branchleft/break-glass-grants'
LOG_DIR = '/var/log/branchleft'
SOCKET = '/var/run/docker.sock'
TIMER = 'branchleft-break-glass-expire.timer'
PROG = 'branchleft-break-glass'

# systemctl answers in milliseconds. One that does not answer within this many
# seconds counts as inactive, so the grant is refused rather than left waiting.
SYSTEMCTL_TIMEOUT_S = 10


def timer_state():
    # The container cannot ask systemd, so the host answers, and the tool refuses
    # a grant unless the answer is exactly "active". A systemctl that cannot be
    # run, exits non-zero or does not answer in time is "inactive".
    try:
        done = subprocess.run(
            ['systemctl', 'is-active', '--quiet', TIMER],
            timeout=SYSTEMCTL_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 'inactive'
    return 'active' if done.returncode == 0 else 'inactive'


def main():
    state = timer_state()
    argv = [
        'docker', 'run', '--rm', '--pull', 'never', '--network', 'none',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '64', '--memory', '256m', '--user', '0:0',
        '--label', 'branchleft.component=break-glass-tool',
        '--mount', f'type=bind,source={TOOL_DIR},target={TOOL_DIR},readonly',
        '--mount', f'type=bind,source={STATE_DIR},target={STATE_DIR}',
        '--mount', f'type=bind,source={LOG_DIR},target={LOG_DIR}',
        '--mount', f'type=bind,source={SOCKET},target={SOCKET}',
        '-e', f'BL_EXPIRE_TIMER_STATE={state}',
        IMAGE, 'node', f'{TOOL_DIR}/break-glass-grant.mjs',
    ] + sys.argv[1:]
    # Replaces this process, as the shell's exec did: the exit status, signals and
    # standard streams are the container's. Nothing is printed here but the
    # failure to start docker, never an argument.
    try:
        os.execvp('docker', argv)
    except OSError as exc:
        sys.stderr.write(f'{PROG}: docker: {exc.strerror}\n')
        sys.exit(127 if isinstance(exc, FileNotFoundError) else 126)


if __name__ == '__main__':
    main()
