# media_backup_weekly.py

## Module overview

The weekly media backup. For every tenant in the recipients file it reads that
tenant's folder on the shared media buckets with the shared read-and-list key,
straight from the provider and never through the storage gateway (so a gateway
outage does not stop a backup), encrypts each object to that tenant's own age
recipient, and writes a dated copy in the backup bucket. It is the scheduled
caller of `media_backup_restore.backup_tenant_media`, which holds the
encryption, the manifest and the layout:
`media/<tenant>/generations/<run id>/...`. A systemd timer on the control host
runs it once a week.

```text
media_backup_weekly.py [--recipients-file F] [--folders-file F] [--check]
```

Exit 0: every tenant was copied. 1: a tenant failed (the rest still ran). 2:
refused before any request, because a setting or a file could not be trusted.

## Inputs

| Input | What it is |
|---|---|
| `/etc/branchleft/backup-worker-recipients` | `tenant recipient` per line, the same file the nightly dump loop reads. One recipient per tenant; two tenants on one recipient refuse the run. |
| `/etc/branchleft/backup-worker-media-folders` | `tenant bucket folder` per line, then optionally `no-media`. Says which shared bucket and which opaque folder is each tenant's. A folder claimed by two tenants refuses the run. |
| environment | The eleven `MEDIA_*` names in `ENV_NAMES`: live endpoint, region and key; backup endpoint, region, bucket and key; the manifest signing key file; the request ceiling. None has a default. A refusal names a setting, never a value. |

The folders file exists because the gateway holds the tenant-to-folder map and
this host does not. `no-media` is the operator saying a tenant has no media at
all; without it an empty folder fails that tenant, because an empty listing is
also what a wrong bucket or a broken listing looks like.

## Where the copies go

The backup bucket only. A bucket whose name contains `media` is refused as the
backup bucket, and so is a bucket that is also one of the live buckets. A media
bucket is never given an expiry because that would delete live objects; the
backup bucket's `media/` rule is the one that expires dated copies after the
retention, so the copies must never be written anywhere else.

## Pacing

The provider allows 750 requests a second per source address and, separately,
per bucket, and neither limit can be raised. One `RequestPacer` spaces every
request the run makes, reads and writes alike, to `MEDIA_BACKUP_MAX_REQUESTS_PER_SECOND`.
It is one pacer for the whole process because the limit is per source address,
and that also holds each shard's share below the same ceiling. The setting is
refused above `HARD_CEILING_REQUESTS_PER_SECOND` (400), so the other traffic on
the shard (edge cache misses, gateway uploads) and the host's own nightly dump
uploads always have headroom. Its value is set from measurement.

A `503` is retried up to `MAX_ATTEMPTS` times with a jittered doubling backoff
capped at 60 seconds. Each one is counted and halves the rate (never below
1 a second); 200 requests without one raise it a quarter at a time back to the
ceiling. A run that meets sustained SlowDown therefore slows itself. A request
still `503` after the last attempt fails that tenant, not the run.

## What it reports

One line per tenant (`ok` with the run id, object count, bytes and the manifest
key, or `FAILED` with the reason) and one summary line: tenants, failures,
objects, bytes, requests, slowdowns, the ceiling, the final rate and
`duration_seconds`. The duration at the paced rate is how the estate shows it
is outgrowing a weekly window. The lines go to the journal.

## What it never does

- Write a file of plaintext: objects are held in memory and reach `age` on its
  standard input. The tests scan the run's disk and every request body for a
  marker in the plaintext.
- Delete anything, anywhere. Old copies leave by the bucket's lifecycle rule.
- Read a tenant's folder with another tenant's recipient, or any folder not
  listed in the folders file.
- Take a missing setting from a default.

## Known limits

- An object is read whole into memory, so the unit's memory limit bounds the
  largest object.
- The tenants are copied one after the other, so the run's length is the sum of
  their sizes at the paced rate.
- The put-only key cannot read the backup bucket, so the first run's result is
  read back with the read key; the manifest key in each tenant's line says what
  to look for.
