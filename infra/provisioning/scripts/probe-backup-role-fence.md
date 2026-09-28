# probe-backup-role-fence.py

The narrative behind `probe-backup-role-fence.py`, moved out of the code.

## How the probe works

Prove the role-aware backup fence against the live bucket, one role at a time.

Run by hand by the platform owner, after the fence rendered with
`render-bucket-fence-policy.py --writer-access-key ... --reader-access-key ...`
has been applied. It writes only under a probe prefix, and the operator key
removes every version it wrote before it exits.

WHY CURL. Every request goes out through `curl --aws-sigv4`, because `aws
s3api` v2 renders no S3 error code for this endpoint's error documents, and a
denial is only a denial when its `Code` says `AccessDenied`. The same 403
answers a wrong key, a wrong region and a working fence; `classify()` from
`verify-bucket-fence.py` reads the code and is reused here rather than copied.

WHY IT WAITS. The engine's policy read path serves the previous decision for a
while after a change. A probe inside that window reads the old policy, which
after a first apply is Hetzner's project default -- allow everything -- and
after a re-apply can be a stricter old fence that makes a wrong new one look
right. So the probe waits `--dwell` seconds before its first pass, then runs
every check a second time after `--recheck` more, and a check whose two
passes disagree is INCONCLUSIVE, never PASS.

WHY THERE ARE CONTROLS. A key that reaches nothing is denied everything, and
an all-deny must not read as a fenced bucket. Every denial is counted only if
the same role's control -- the one action that role must be able to do --
succeeded in the same pass. The operator's seed write is the control for the
run as a whole: if it fails, nothing after it is evidence.

THE CONFIGURATION DENIES. The writer and the reader each try three
configuration writes, and each write changes nothing if it is wrongly
allowed:

- re-PUT the bucket policy the operator has just read, byte for byte;
- set versioning to `Enabled`, which it already is;
- (writer only) set a `private` ACL on the writer's own probe object.

The operator sends each of these requests first, as an allow check. That is
the shape control: a denial counts only if the operator's identical request
succeeded in the same pass. Otherwise a malformed request would read as a
working fence.

`DeleteBucketPolicy` and `PutLifecycleConfiguration` are not probed, because
a wrongly allowed call would open the bucket or expire its backups. Both are
withheld by the same statement as `PutBucketPolicy`
(`DenyBucketConfigurationExceptOperator`), and the writer is also held by the
bucket catch-all `Deny s3:*`. The object-tagging writes are not probed either.

WHAT IT CANNOT PROVE. It probes the actions it names. `HeadObject` is not
probed separately: it is authorised as `GetObject`, and a HEAD response
carries no body, so its denial has no error code to read. An action outside the
parser's vocabulary cannot be named in any policy on this engine, so it
cannot be denied, and it is not probed either.

Credentials come from six environment variables, read by name and handed to
curl on stdin, never on its command line where `ps` would show them:

  PROBE_OPERATOR_ACCESS_KEY_ID  PROBE_OPERATOR_SECRET_ACCESS_KEY
  PROBE_WRITER_ACCESS_KEY_ID    PROBE_WRITER_SECRET_ACCESS_KEY
  PROBE_READER_ACCESS_KEY_ID    PROBE_READER_SECRET_ACCESS_KEY

Exit status: 0 every check passed in both passes; 1 a check failed; 2 the
run was inconclusive or could not start.
