# promote: the promotion attestation

One candidate image digest, one signed verdict. The `promote-candidate` workflow
(`.github/workflows/promote-candidate.yml`) runs the six gates on the digest,
classifies the Ghost migrations new since the pinned tag, and signs the result
onto the digest as an attestation. Its signing identity is that workflow file,
which is not the file that pushed the image, so the push cannot also sign.

Fixed code only. No model, no agent and no person is in the path.

## The predicate

Type `https://github.com/branchLeft/ghost-platform/promotion/v1`, schema `promotion/v1`.

| Field                                | Meaning                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `digest`                             | The candidate image digest. Also the attestation's subject.                                                         |
| `version`, `fromVersion`             | The Ghost release the candidate carries and the pinned release it moves from, as plain tags.                        |
| `route`                              | `fast-path` only when the classification is reversible and the gate record is green and complete. Otherwise `consent`, the refused route: it asks nobody. |
| `policySha256`                       | The sha256 of the bytes of the policy file named at dispatch.                                                        |
| `classification`                     | `ok`, the record's schema and class, and the two upstream commits the tags resolved to.                              |
| `gates`                              | `ok` and one row per gate, name and result only. No gate log is carried.                                             |
| `refusals`                           | Empty on fast-path. Otherwise one row per refusal: the source (`classification` or `gates`), the reason and detail.  |

Every verdict is recomputed from the raw records: `assertReleaseReversible`
(the release gate) over the steps record, and `verifyReport` (the gate set's
verifier) over the gate record. Neither record's own summary is read. The
migrations-new-since-the-pinned-tag classifier is `services/release-classifier`
(`steps.mjs`); this directory calls it and carries no copy.

## Scripts

| Script                      | What it does                                                                                           | Exit                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `fetch-ghost-migrations.mjs` | Fetches Ghost's `migrations/versions` at one release tag (blobless, shallow, sparse) and prints the commit. | 0 printed, 1 anything else                 |
| `build-predicate.mjs`       | Builds the predicate. An unreadable record is a consent predicate; input that cannot be recorded writes nothing. | 0 written (either route), 1 nothing written |
| `check-predicate.mjs`       | The signing job's check on the file it is about to sign. Node built-ins only.                           | 0 accepted, 2 refused, 1 usage              |
| `verify-promotion.mjs`      | Verifies the stored attestation the way a host will, through the API and the registry bundle, with the predicate type named; then requires a wrong signer to be refused for its identity. A read that did not come back is retried, five attempts. | 0 verified, 2 refused, 1 usage |

`shape.mjs` holds the predicate type and the one check (`checkPredicate`) every
reader shares: the right digest and release, a policy hash, a known route, and
for a fast-path predicate its own evidence (reversible, a green record holding
each required gate once, no refusal).

## The workflow

Dispatched by hand from `main` with the digest, the two tags and the policy file
path. Three jobs, so the one that can sign installs nothing:

1. `gates` pulls the digest and runs the gate set on it. Reads packages.
2. `decide` reads Ghost's migrations at both tags, runs the classifier and builds the predicate. Installs the classifier's one dependency. Cannot sign.
3. `attest` checks the predicate, signs it, verifies it, and proves a wrong signer is refused. Installs nothing. The only job with `id-token`, `attestations` and `packages: write` (the last stores the signed bundle beside the image; nothing is pushed).

`workflow-promote-candidate.test.js` pins these properties as text.

## Not claimed

- Nothing calls this workflow, and nothing yet refuses an image that lacks the attestation: that is the host check.
- No policy file exists yet. The workflow hashes whichever path it is given.
- One step is classified: the pinned tag to the candidate's tag, comparing the two trees. A chain of releases is not built.
- The gate set's `digest` is the candidate image digest here. Its own CI job uses the digest the Dockerfile pins.
- `gh attestation verify --format json` output shape and the gates against a pulled digest are exercised only by a live run.
- The verify step is a second home for attest-then-verify beside the shared action, which verifies build provenance only. Folding a predicate type into the shared action is a follow-up in the workflows repository.
