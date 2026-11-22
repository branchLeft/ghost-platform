# recycle.ts

## What a recycle is

`POST /reset` is the recycle of a demo slot (LLD-2): the lease and the gate hash
are revoked, both colours stopped, the slot wiped, and the slot is `free` for the
next lease. The recycle adds the two residues the wrapper cannot reach, and
makes `free` mean that every one of them is gone:

| Residue                         | Removed by                                                                                                              | Proven by                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| the gate cookie                 | the lease record and gate entry removed first (`clearLeaseAndHash`); the next lease gets a new id and a rotated hash    | `recycle.test.ts`; the real-Caddy gate proof (`scripts/test-demo-gate.sh`)      |
| the slot directory, both colours, the volumes, the env files | the wrapper's `reset` verb                                                                         | `demo-host/provision/test_recycle_residue.py`, `sabotage_recycle_residue.py`    |
| the lease's unsent mail         | `RecycleEffects.purgeUnsentMail`, by lease id (`mailgun-shim`'s `purgeLease`, `purge-lease`)                            | `services/mailgun-shim/test/unit/storeLeasePurge.test.ts`, `recycle.test.ts`    |
| the hostname                    | the gate entry removed with the lease; `RecycleEffects.retireHostname` appends its retirement to the portal's register  | `recycle.test.ts`; `portal/data/test/hostnameRegister.test.ts`                  |

## Order

In `handleReset`, inside the slot lock:

1. Read the lease and hostname the slot holds (`readRetiringLease`) and write
   them into the slot's state as `retiring`, with phase `resetting`.
2. Remove the lease record and the gate entry. The previous visitor's cookie is
   dead from here, whatever happens next.
3. Forget the slot's Ghost key; run the wrapper's `reset`.
4. Only then: purge the lease's unsent mail, then retire the hostname.
5. Write `free`, which drops `retiring`.

The purge comes after the wrapper because the wrapper stops both colours: until
Ghost is stopped it could queue more mail under the old lease. The hostname is
retired after the mail so a retired name never has unsent mail behind it.

## A frozen slot is recycled the same way

`POST /freeze` also removes the lease record, so it reads `retiring` first,
before access is cut, and writes it into the state (an unreadable record stops
the freeze there, `detaching` and `frozen`, access untouched). `releaseHeldEvidence`
carries it through the confirmed detach. A `/reset` after the detach therefore
purges and retires exactly as one on a running slot does, and ends `error`, never
`free`, while an effect fails. `recycle.test.ts` covers freeze, then reset.

## A failure never ends `free`

A failing wrapper, purge or retirement writes `error` and answers 503. `retiring`
is carried in the state through every write until `free` (`writeSlotState`), so a
retry, or a broker that died mid-reset and was recovered at boot, still knows
which lease's mail to purge after the lease record is gone. Both effects are
idempotent: a retry repeats them harmlessly.

A lease record that exists but cannot be read is a 503 with nothing removed: the
lease it names is unknown, so its mail could not be purged by lease, and the
broker does not guess. An operator settles it (the record is the file
`<leaseDir>/<slot>.json`).

## Not wired yet

`server.ts` wires `UNWIRED_RECYCLE_EFFECTS`: both effects reject. A reset of a
slot that held a lease therefore ends `error` through a broker as shipped, never
`free` with its mail unpurged. A slot that held no lease is unaffected. The real
effects are two clients, not built here: one calls the spool's `purge-lease` on
the demo host, the other writes the portal register's retirement
(`ProvisionerDb.retireHostname`). Until they are wired, the recycle is proven
with stand-ins at exactly this seam.
