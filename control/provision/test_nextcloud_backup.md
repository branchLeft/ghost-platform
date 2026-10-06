# test_nextcloud_backup.py

## Module overview

Unit tests for `nextcloud_backup.py`. Every docker call is faked by
`FakeDocker`, and every file lives in a temporary directory. No real stack,
host or Docker daemon is needed. The fakes return synthetic text, and a
marker string checks that failure messages never echo command output.

`DockerProofTest` is the real proof. It runs only when
`NEXTCLOUD_BACKUP_DOCKER_PROOF=1` is set. It builds a synthetic stack under
Compose labels: a labelled volume, plus a throwaway PostgreSQL holding
synthetic `oc_calendars` and `oc_calendarobjects` rows. It then runs `take`
and `verify` for real and checks that:

- a real backup restores with equal counts;
- **the control case:** the same check, pointed at an empty database (a dump
  with nothing in it), exits 1;
- a count mismatch exits 1.

The proof labels everything it creates (`branchleft.agent=nextcloud-backup-proof`)
and removes it afterwards. It also asserts that no `branchleft.nextcloud-backup`
throwaway is left behind. Set `NEXTCLOUD_BACKUP_PROOF_IMAGE` to use a local
image instead of the pinned digest, and `NEXTCLOUD_BACKUP_PROOF_TMP` to choose
where the backups are written. On macOS that directory must be shared with
Docker.
