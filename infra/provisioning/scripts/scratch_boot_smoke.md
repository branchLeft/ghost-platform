# scratch_boot_smoke.py

The second part of the pre-swap scratch-copy gate. Part 1
(`scratch_preflight.md`) restores a tenant's newest verified backup into a
throwaway MySQL server. This part keeps that server, boots the green colour
(the candidate Ghost and its drain sidecar) against the restored copy with no
public traffic, runs the smoke checks, and exits nonzero, printing `REFUSED`,
unless every check passes. A caller that runs the gate treats any nonzero exit
as "do not swap".

It is deterministic software. No agent takes part in it.

## One run

1. **Pull the colour's images**, by digest, if absent. A failure here refuses
   before anything is started.
2. **Part 1**, with `keep`: backup verified, restored, compared with its
   manifest. Any refusal there ends the run before a colour exists.
3. **Boot the green colour** on the scratch server's network:
   - the network is `--internal`, so the colour has no route out of the host: it
     cannot send mail, call a payment provider or reach the tenant's real
     database host;
   - no port is published and the host network is never used, so nothing outside
     the scratch network can reach it either;
   - the Ghost container is given the scratch server's name as its database
     host, the restored database, and the scratch password as an environment
     value (never argv);
   - the sidecar shares the Ghost container's network namespace, exactly as the
     drill's colour does, and starts with the drain flag **set**.
4. **Smoke checks**, in order. The first to fail ends the run:

   | Check | What it proves |
   |---|---|
   | `drained at boot` | The sidecar reports the drained state (503) while the flag is up, so a colour that came up in rotation is caught. |
   | `serves` | Ghost answers 200 on `/` within the content timeout. |
   | `tenant content` | The rendered page carries the site title and the newest post title the backup's manifest recorded. A 200 is never the check: a Ghost on an empty database serves 200 too. |
   | `ready once undrained` | With the flag removed, the sidecar reports ready (200). |

   The flag is removed only after the content is proven. The checks read each URL
   from inside the Ghost container (`docker exec ... node`), so no host port is
   needed.
5. **Discard**, whatever happened: the sidecar, Ghost, the scratch server, its
   network, the plaintext dump and the drain-flag directory.

`ok` is set only after all four checks pass.

## What it never does

It holds no address for the tenant's database host and takes no argument that
could name one. It publishes no port. It never writes to the tenant's database,
the bucket or any other server, and it never reads the tenant's live data. It
does not print Ghost's logs: they may carry member data, and they go with the
container.

## Exit codes

The same as part 1: 0 passed, 1 refused (the reason is the last line on stderr),
2 not run (no `--tenant`, a malformed option or environment, or another gate
run holds the lock), 143 stopped by SIGTERM with cleanup done first.

## Configuration

The gate reads the drill's environment file (`BACKUP_DRILL_*`, see
`restore_drill.md`): the copies, the images by digest, the identity directory,
the work directory, the flag root and the Ghost memory limit. `--ghost-image`
names the green colour's Ghost image by digest and replaces the configured one,
so the candidate is the colour under test.

```
scratch_boot_smoke.py --tenant TENANT [--copy NAME] [--ghost-image IMAGE@sha256:DIGEST] [--max-age-hours N]
scratch_boot_smoke.py --cleanup
```

`--cleanup` runs part 1's cleanup (every labelled container, including the
colour's, every labelled network, every `preflight-run-*` directory) and then
removes the `preflight-flag-*` directories under the flag root. Run it after any
stop, a SIGKILL included. It never touches the drill's own `run-*` directories.

`--allow-disk-work-dir` skips the tmpfs check for a local proof. The
environment cannot.

## What the tests prove, and what they do not

`test_scratch_boot_smoke.py` runs part 1's restore for real and fakes Docker
and the colour's HTTP. Each control is a colour that must not pass:

| Control | Refused at |
|---|---|
| Ghost never serves | `serves` |
| Ghost serves a page without the tenant's content (an empty database) | `tenant content` |
| The sidecar is not drained at boot | `drained at boot` |
| The sidecar never reports ready | `ready once undrained` |
| The colour's containers cannot start | the start, everything removed |
| An image cannot be pulled | before anything starts |
| Part 1 refuses the restore | before a colour exists |

Each control has a twin with the smoke checks removed, which passes: the
refusals come from the checks. The tests also pin that the colour is attached
to the internal network only, publishes nothing, reaches only the scratch
server as a database, takes the password as environment, comes down before the
network, and that SIGTERM mid-boot removes everything.

They do not prove the container wiring: that the pinned Ghost and sidecar
images start on the scratch network, that `node` in the Ghost image answers
the probe, and that Ghost's boot migrations on a real tenant's data complete
within the content timeout. That proof is one run of the gate on the control
host against a real backup, which needs the host.
