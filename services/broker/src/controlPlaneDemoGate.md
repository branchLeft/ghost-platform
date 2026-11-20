# controlPlaneDemoGate.ts

## issueDemoGate

A new passphrase and the argon2id hash a descriptor carries. The passphrase is
20 base32 letters in four groups, 100 bits, drawn from the operating system's
random source. It is returned once, to the caller that sends the arrival mail,
and held nowhere here; only the hash reaches the host.

The hash is the demo gate's own PHC form with the parameters the gate mints
with (`services/demo-gate/src/argon2id.ts`: 64 MiB, 3 passes, 4 lanes, a
16-byte salt and a 32-byte tag), so the gate verifies exactly what this
produces. A fresh salt every call means two demos never share a hash, which
matters: the broker refuses a descriptor whose gate hash has not rotated since
the slot's last tenancy, so a retry must carry a fresh passphrase.

`GateIssuer` is the seam a test replaces so the provisioning tests do not pay
the argon2 cost; the real issuer is tested against `node:crypto`'s own argon2.
