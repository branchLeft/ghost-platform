# provisioning-controller

Part 1 of the tenant provisioning controller: the planning half. From one
recorded owner approval and the tenant register it returns an ordered, typed
plan of every onboarding step. It executes nothing and writes nothing.

- `planOnboarding(approvalId, ports)` is the only entry. The approval id is
  the only trigger; the tenant comes from the recorded approval and every
  input from the register. No approval, or one that does not cover setup, the
  web address and the first deploy, yields no plan.
- Each `PlannedStep` has a stable `key` (`<tenant>/<step id>`), its
  `dependsOn`, typed `inputs` (names of secrets, never values) and an
  `inputDigest`. A consumer records state per key and compares the digest to
  notice a changed register on resume.
- The register and the approval ledger are ports (`src/ports.ts`). The
  portal data package owns the real register but is not importable from here,
  and it does not yet hold the media, bucket, slot, port, user id and hostname
  columns, so an adapter is needed before this runs for real.
