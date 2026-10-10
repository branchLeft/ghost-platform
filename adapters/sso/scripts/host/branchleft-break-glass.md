# branchleft-break-glass.sh

## Overview

The one command an operator runs on an app host to open, close or list
break-glass grants, installed as `/usr/local/sbin/branchleft-break-glass`
(root-owned, mode `0700`). The host has no Node. This script asks systemd one
question, then starts the grant tool in the pinned Node image and passes every
argument through to it:

```sh
branchleft-break-glass grant --lane consented|incident --tenant <slug> \
  --reason <one line> --reference <one line> [--identity <support email>]
branchleft-break-glass revoke --tenant <slug> --reason <one line>
branchleft-break-glass status
```

## What it does

1. Runs `systemctl is-active --quiet branchleft-break-glass-expire.timer` and
   sets `BL_EXPIRE_TIMER_STATE` to `active` or `inactive`. A `systemctl` that
   cannot run counts as `inactive`. The tool refuses a grant unless it is
   exactly `active`, so a grant can only open while something will close it.
2. `exec`s one `docker run --rm` of the image pinned by digest, with no
   network, a read-only root, no capabilities and no new privileges, and four
   `--mount`s: the tool directory read-only, the grant state directory, the
   grant log directory, and the Engine socket.

It takes no flag, no environment value and no file that changes the image, the
mounts or the options: they are constants at the top of the file. `--mount`
(rather than `-v`) is used because it fails when a source directory is missing
instead of creating one with the wrong owner and mode.

The expire unit (`../systemd/branchleft-break-glass-expire.service`) starts
the same container with the same options; a unit test compares the two.

## What it does not do

It never mounts the signing key directory (that is on `ops1` only), prints no
token or URL, and passes no secret in argv: grant arguments are the tenant slug
and two operator-written lines.
