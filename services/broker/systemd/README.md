# The broker's systemd unit: what a real boot found

Everything below was found by actually booting `branchleft-broker.service`
under a real `systemd` (`test/live/fixtures/systemd-boot/`,
`.github/workflows/broker-systemd-boot-ci.yml`), not by reading `systemd.exec(5)`
or `sudo(8)` alone. Short pointers to this file sit beside the line each
finding fixed; the reasoning lives here once.

## `no_new_privs` is forced by more than `NoNewPrivileges=`

The unit's `sudo -n` call into `branchleft_slot.py` needs the kernel to
honour `sudo`'s setuid-root bit on exec, which the kernel's own
`no_new_privs` process bit blocks outright once set — and, on a non-root
`User=` with no capabilities, installing a seccomp filter requires that bit
(`seccomp(2)`: `CAP_SYS_ADMIN` is the only way around it). So **any
directive the kernel implements via a seccomp filter forces `no_new_privs`
regardless of what `NoNewPrivileges=` is configured to**, invisibly:
`systemctl show -p NoNewPrivileges` keeps reporting the unit's own setting
correctly; only `/proc/<pid>/status`'s `NoNewPrivs` on the running process
shows the kernel's real state.

Tested individually against a real boot: `SystemCallFilter=`,
`SystemCallArchitectures=`, `RestrictAddressFamilies=`,
`RestrictNamespaces=`, `RestrictRealtime=`, `LockPersonality=`,
`RestrictSUIDSGID=`, `MemoryDenyWriteExecute=`, `ProtectClock=`,
`ProtectKernelTunables=`, `ProtectKernelModules=`, `ProtectKernelLogs=` and
`ProtectHostname=` all forced it, and are absent from the unit as a result.
`unitFileNoNewPrivileges.test.ts` asserts none of them are set, rather than
only the literal `NoNewPrivileges=no` line, so re-adding any one of them
fails the suite even though the literal line would still read `no`.

`CapabilityBoundingSet=` (narrowed to empty) is absent for a different
reason: a setuid-root exec (`capabilities(7)`) grants the new process
capabilities out of the *calling* process's own bounding set, not just the
target file's, so narrowing it here would cap what `branchleft-slot` itself
can hold as root even though `sudo`'s own grant already scoped what it may
run.

What remains — `ProtectSystem`, `ProtectHome`, `PrivateTmp`,
`ProtectControlGroups`, `ProtectProc`, `UMask`, `StateDirectory`,
`ReadWritePaths`, `ReadOnlyPaths` — was each tested individually and
confirmed not to set `no_new_privs`; a real signed `POST /reset` reaches
`branchleft_slot.py` through `sudo -n` and gets a real reply with all of
them applied together.

## `--preserve-symlinks-main`

`RUNBOOK-broker-deploy.md`'s upgrade step swaps the `current` symlink to a
new release directory rather than overwriting files in place, so a request
in flight never sees half-written files. That is only safe with
`--preserve-symlinks-main`: without it, `server.ts`'s own
`import.meta.url === pathToFileURL(process.argv[1]).href` check is false,
because Node resolves `import.meta.url` through the symlink to its target
under `releases/<release>/` but never re-resolves `argv[1]`. `main()`
silently never runs — the unit exits `0/SUCCESS` in under two seconds, no
log line, nothing listening, and `Restart=on-failure` does not fire on a
clean exit. `unitFileExecStart.test.ts` proves the flag is both present and
ahead of the entrypoint path (Node treats the first non-flag argument as
the script to run).

## The verify key: `root:broker 0640`, not `broker:broker 0600`

`config.ts#loadConfig`'s `readFileSync` opens `BROKER_VERIFY_KEY_FILE`
directly from the unprivileged broker process, unlike `broker.env` (read by
systemd-as-root on the process's behalf via `EnvironmentFile=`), so the
`broker` account needs *read* access. It does not need *write* access —
nothing in this codebase ever writes that file after install — so `root:broker
0640` gives the account group-read without giving the broker process (or
anything that compromises it) the ability to replace its own request-signing
trust anchor. `ReadOnlyPaths=/etc/branchleft/broker-verify-key.bin
/etc/branchleft/broker.env /opt/branchleft/broker` restores the mount-level
protection `ProtectSystem=strict` would otherwise give these paths before
`ReadWritePaths=/etc/branchleft` widened the whole directory — the deeper,
more specific path wins inside a `ReadWritePaths` entry, and neither the
broker nor the wrapper ever writes any of the three.

## `/etc/branchleft` and `/var/lib/branchleft` are writable

`ProtectSystem=strict`'s read-only mount applies to this unit's whole
process tree, including the `sudo`-elevated `branchleft_slot.py` it execs —
a mount namespace is inherited across exec regardless of which UID is now
running in it. Two real, independent writes need this:

- `branchleft_slot.py`'s `reset` removes each colour's
  `/etc/branchleft/<slot>-<colour>.env` as part of tearing a slot down —
  without `/etc/branchleft` in `ReadWritePaths`, that `unlink()` fails with
  `Read-only file system` even though the wrapper is, by that point,
  genuinely running as root.
- `BROKER_SLOTS_FILE` (`/var/lib/branchleft/slots.json`) is written
  directly by the unprivileged broker process itself
  (`writeLeaseAndHash`/`clearLeaseAndHash`, atomically: a temp file into the
  same directory, then a rename), so both the file and its containing
  directory need to be broker-writable. Missed on the first boot proof
  because that proof's fixture seeded an *empty* `{"slots": []}`:
  `removeSlotEntry` skips the write entirely when nothing matches, so a
  reset against an empty slots file never touches the mount at all. The
  fixture now seeds a real leased slot "0" and the proof resets it, so a
  regression here fails loudly again.

## `UMask=0022`, not `0077`

`UMask=` is a process attribute, not an environment variable, so `sudo`'s
`env_reset` does not touch it — the unit's `UMask=` is inherited straight
through `sudo -n` into `branchleft_slot.py`. Two of this codebase's own
`writeFileAtomic` call sites pass an explicit mode wider than owner-only —
`slotsFile.ts` (`0640`, the shared file `services/demo-gate` also reads) and
`drainFlag.ts` (`0644`) — and a `0077` umask silently strips those back to
`0600` (`mode & ~umask`), the exact silent narrowing this project doesn't
want. `0022` leaves both untouched. The same inheritance means the
wrapper's own directory-recreation (`recreate_empty_dir`) stops being forced
to `0700` regardless of what it asks for.

## `IPAddressDeny=any` / `IPAddressAllow=localhost`, `PrivateIPC=yes`, `RemoveIPC=yes`

Added on the same reasoning as the directives above — none of the three
uses a seccomp filter (cgroup-BPF for the address filter, a private IPC
namespace for the other two), so none should force `no_new_privs`, and
`sudo -n` execing a local root process needs neither non-loopback network
access nor System V/POSIX IPC. **Not yet proven by a real boot at this
head** — Docker was unavailable when these were added; the next real boot
proof must confirm both that the unit still starts and that `/reset` still
reaches the wrapper with these applied, the same way every directive above
was individually confirmed.

## Known gap: `BROKER_SLOT_DIR_BASE` vs. the wrapper's own path

`writeArtefacts.ts` writes reconciled artefacts under
`<BROKER_SLOT_DIR_BASE>/<slot>/`; `branchleft_slot.py`'s `reset` wipes
`/opt/branchleft/demo-<slot>` — a different, hyphenated path no value of
`BROKER_SLOT_DIR_BASE` can produce through `path.join`, which always inserts
a separator. With the shipped template, a reset never clears what a prior
reconcile wrote. Fixing it means changing either `writeArtefacts.ts`'s own
directory convention (tested against `<base>/<slot>` across
`writeArtefacts.test.ts`, `renderCorePlugin.test.ts` and `server.test.ts`)
or the wrapper's own `SLOT_DIR` — both outside this file's remit and named
by branchLeft/workspace#1545 as branchLeft/workspace#1447/#1448's territory,
not touched here. Filed as discovered work rather than worked around in this
PR.
