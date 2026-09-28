# locationCheck.ts

## assertColocatedWithEdge

The argument is the estate stack's `estateLocation` output — the location
`edge1` was applied in, read from the created server. Comparing against the
constant is not enough on its own: a stack that has already applied does
not follow a later edit to `ESTATE_LOCATION`, so the constant says where
the estate is meant to be while the output says where it is. `location` is
create-time-only on `hcloud.Server`, which makes a mismatch permanent for
every host created under it — hence throw, never warn.
