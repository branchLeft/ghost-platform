# probe-gateway-storage.py

The narrative behind `probe-gateway-storage.py`, moved out of the code.

## What it is for

The storage gateway re-signs what it forwards to the object storage backend. Several
questions about how the backend treats those requests were never measured. This program
asks them of a throwaway bucket in two locations: the one under test (the target) and a
second one (the control). It prints one line per probe per location, then one comparison
line per probe.

It is run by hand. It makes no change to anything but the two throwaway buckets, and it
removes what it wrote before it exits.

## Inputs and what is never shown

Every option takes the NAME of an environment variable. The values (endpoint, location,
bucket, and the access key id and secret of two keys) are read from the environment. No
value goes on a command line, into a file, or into output:

- an argument that is not a plausible variable name is refused without being echoed;
- a refusal names the option, never the value;
- every line is passed through a redactor that replaces each endpoint, bucket, key id and
  secret with a marker, and a probe that raises is reported by exception type and a
  redacted message;
- the credential objects hide their fields from `repr`.

The two keys belong to two different projects. The owner key is the bucket's own project
key. The fence key is a key in a separate, key-only project.

## Verdicts

Each probe ends in one of three verdicts, for one location:

- `PASS`: the backend answered the probed operation, and every control the probe ran
  first behaved as it must.
- `FAIL`: the backend answered, the controls held, and the answer is the unwanted one.
- `INCONCLUSIVE`: a control failed, a call got no usable answer, or the answer could come
  from something other than the property. It is never reported as a pass.

Controls come before probes: a denial means nothing until something has shown the key
works at all.

## The probes

`head-missing`. The owner key writes an object and lists the bucket (so it holds
`ListBucket`), then a `HEAD` of a present object must be 200 before a `HEAD` of a missing
object is read. 404 passes; 403 fails.

`upload-no-crc32`. A single upload with Ghost's CRC32 checksum header is the control. A
single upload without it, then a three-step multipart upload without it (create, two
parts, complete), are the probe. The object is read back and compared by digest. If no
upload is accepted either way the verdict is inconclusive; if the control is accepted and
the plain upload is not, it fails.

`allow-fence`. The fence key must be refused before any policy exists (otherwise an Allow
cannot be shown to be what admits it). The owner key then applies a policy with one Allow
naming the fence key's principal only, and the program polls the fence key's write until
it is admitted or the dwell time ends (policy changes have been seen to take minutes).
Once admitted, the fence key reads and lists; an unsigned request and the bucket-project
key must both be refused the object the fence key wrote. Any admitted extra reader fails
the probe. The policy is removed before exit.

`ipv6`. A normal-path `HEAD` of the bucket is the control. Then the endpoint's IPv6
addresses are looked up and a signed `HEAD` is sent over IPv6 only. No IPv6 address at
the endpoint fails. A host with no IPv6 route, or any connection failure, is
inconclusive: the host and the backend are not told apart.

`limit-counting`. Not measured. Telling a per-address request limit from a per-/64 one
needs two source addresses in one /64 and a request rate at the limit against two
buckets, which this program does not do. It always reports `INCONCLUSIVE` with that
reason, so a missing measurement cannot read as a pass.

`write-and-abandon`. Eight writes to one key, each with an answer deadline. Any write
with no answer fails the probe, and the read-back says whether the unanswered write
committed. Then a one-megabyte write is sent whole and the connection is closed without
reading the answer; the object is polled for. Present and intact passes; present and
damaged fails; not visible in the window is inconclusive, because a later commit cannot
be ruled out.

## The comparison

For each probe the two locations' outcomes are compared:

1. If either location is `INCONCLUSIVE`, the comparison is `INCONCLUSIVE`, and a reason
   shared by both is named as such.
2. If both gave the same answer, the comparison is `INCONCLUSIVE`: the probe did not tell
   the locations apart, so it is not evidence about the target beyond the target's own
   line. Each location's own line still stands.
3. If the answers differ, the comparison carries the target's verdict and states what the
   control answered.

The target and control must name different endpoints, buckets and locations; otherwise
the run is refused, because a control that is the target is not a control.

## Cleanup

Everything written is removed in reverse order, the policy last. The `cleanup` line says
how many removals worked and names any key left behind. The bucket itself is not touched;
deleting it is a console step.

## Tests

`test_probe_gateway_storage.py` runs each probe against an in-process fake S3 server
whose behaviour is set per location. The fake behaves differently per location in the
discriminating case, and identically in the case that must come out inconclusive. The
fake sees only key ids; a test asserts the secrets never cross the wire or reach any
output.
