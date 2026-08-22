import * as hcloud from '@pulumi/hcloud';
import * as pulumi from '@pulumi/pulumi';

/**
 * Fails a preview that is pointed at the mail project.
 *
 * hcloud has no fine-grained IAM: a token has full power over everything in
 * its project, and no API endpoint tells a caller which project it is
 * holding. This guard therefore checks a sentinel rather than an identity:
 * it rules the mail project *out* by what is visible in it, and cannot rule
 * the estate project *in* — an empty project passes whether it is the
 * estate's or the lab's.
 *
 * One-directional, deliberately. The mistake in this direction is silent:
 * this stack's state is empty before its first apply, so a mail-project
 * token plans a clean create of both hosts *inside the mail project* and
 * every create succeeds. The reverse mistake is loud and needs no guard —
 * the mail stack's state names its host by id, so an estate token plans a
 * replacement, which no operator confirms by accident.
 *
 * Duplicated from shared-infra's `hetzner/projectGuard.ts` because the
 * package this stack consumes does not export it; consolidation is tracked
 * on the board. The sentinel list must match the mail project's inventory
 * in both copies.
 */

/**
 * Servers whose presence proves the token addresses the mail project.
 *
 * Names rather than ids: an id would have to be recovered from an account
 * nothing here can query, and would go stale the first time the host is
 * rebuilt — at which point the guard would pass against the very project it
 * exists to refuse.
 */
const MAIL_PROJECT_SERVERS: readonly string[] = ['mx1'];

/** The mail-project servers visible to whichever token is in use. */
export function mailProjectServersIn(serverNames: readonly string[]): string[] {
  const seen = new Set(serverNames);
  return MAIL_PROJECT_SERVERS.filter((name) => seen.has(name));
}

/**
 * Throws unless the token's project is free of mail-project servers.
 *
 * An empty project passes, and has to: that is exactly the state of the
 * estate project between its creation and its first apply.
 *
 * The message names only the sentinel it matched, never the server list it
 * was given: that list is the mail project's inventory, and a preview's
 * output is the kind of thing that gets pasted into an issue.
 */
export function assertEstateProject(serverNames: readonly string[]): void {
  const found = mailProjectServersIn(serverNames);
  if (found.length === 0) {
    return;
  }
  throw new Error(
    `hcloud:token addresses the mail project, not the estate project — it can see ${found.join(', ')}. ` +
      'Applying with it would create these hosts inside the mail project. ' +
      "Set the estate project's token with `pulumi config set --secret hcloud:token` and re-run."
  );
}

/**
 * The assertion as the data source hands it over. Split out so the
 * shape-reading — which field holds the list, which field holds the name —
 * is covered by a test rather than only by an apply against a live account.
 * Getting that wrong reads as a guard that passes everything.
 */
export function checkServersResult(result: { servers: { name: string }[] }): boolean {
  assertEstateProject(result.servers.map((server) => server.name));
  return true;
}

/**
 * Reads the token's project and asserts it is not the mail project.
 *
 * Exported as a stack output by the caller rather than left as a loose
 * `apply`: an output is awaited by construction, survives a refactor that
 * stops importing the module for its side effect, and leaves
 * `pulumi stack output` able to show the check is wired at all. It is a
 * constant `true`, so it never adds a diff.
 */
export function verifyEstateProject(): pulumi.Output<boolean> {
  return pulumi.output(hcloud.getServers()).apply(checkServersResult);
}
