# projectGuard.ts

## Fails a preview that is pointed at the mail project

hcloud has no fine-grained IAM: a token has full power over everything in
its project, and no API endpoint tells a caller which project it is
holding. This guard therefore checks a sentinel rather than an identity:
it rules the mail project *out* by what is visible in it, and cannot rule
the estate project *in* — an empty project passes whether it is the
estate's or the lab's.

One-directional, deliberately. The mistake in this direction is silent:
this stack's state is empty before its first apply, so a mail-project
token plans a clean create of both hosts *inside the mail project* and
every create succeeds. The reverse mistake is loud and needs no guard —
the mail stack's state names its host by id, so an estate token plans a
replacement, which no operator confirms by accident.

Duplicated from shared-infra's `hetzner/projectGuard.ts` because the
package this stack consumes does not export it; consolidation is tracked
separately. The sentinel list must match the mail project's inventory
in both copies.
