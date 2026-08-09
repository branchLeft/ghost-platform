import * as gcp from '@pulumi/gcp';
import * as random from '@pulumi/random';
import { dbInstance } from './database';
import { secretWithValue } from './secrets';

/**
 * The MySQL account name. 26 characters, inside MySQL 8.0's 32-character
 * limit for user names. Underscore-separated to match the shape
 * `infra/tenant/database.ts` uses for its own users (`ghost_<identifier>`),
 * with a name that cannot collide with any tenant: tenant users are
 * `ghost_<sqlIdentifier>` derived from a tenant name, and no tenant is called
 * `platform_provisioner`.
 */
const PROVISIONING_USER_NAME = 'ghost_platform_provisioner';

/**
 * Secret Manager ID for this credential's password. `platform`-prefixed, not
 * `ghost-tenant-`-prefixed, so it never sorts or greps alongside the
 * per-tenant credentials `infra/tenant/secrets.ts` creates -- these are
 * different things with different blast radii and should not look alike in a
 * secrets listing.
 */
const PROVISIONING_PASSWORD_SECRET_ID = 'ghost-platform-provisioner-db-password';

/**
 * ============================================================================
 * A platform-owned MySQL credential for running `ALTER USER ... WITH
 * MAX_USER_CONNECTIONS n` against tenant DB users.
 * ============================================================================
 *
 * **Why this exists.** `infra/tenant/database.ts` computes the exact
 * statement doc 02's per-tenant connection limit requires --
 * `ALTER USER '<name>'@'%' WITH MAX_USER_CONNECTIONS n;` -- and then says, at
 * length, that it cannot run it: the Cloud SQL Admin API's `User` resource
 * has no connection-limit field, `infra/platform/database.ts` deliberately
 * never reads the instance's root password, and granting a tenant's own user
 * enough privilege to alter itself would hand it privilege over every other
 * tenant. That comment names the fix -- "a platform-owned, narrowly-scoped
 * provisioning credential added to infra/platform in its own story". This is
 * that credential.
 *
 * ----------------------------------------------------------------------------
 * THE PRIVILEGE QUESTION, ANSWERED FROM SOURCES RATHER THAN FROM THE
 * RESOURCE'S NAME
 * ----------------------------------------------------------------------------
 *
 * The open question this story had to settle: does a plain, non-root user
 * created through the Cloud SQL Admin API (which is all `gcp.sql.User` can
 * create) hold enough privilege to execute that ALTER USER statement?
 *
 * **Yes -- and the answer is uncomfortable, because it holds far more than
 * that.** Google's own "About MySQL users | Cloud SQL for MySQL"
 * documentation (https://docs.cloud.google.com/sql/docs/mysql/users, read
 * 2026-08-05) states that a user created with built-in authentication on a
 * MySQL 8.0 instance is automatically granted the `cloudsqlsuperuser` role,
 * which carries **all MySQL static privileges except `SUPER` and `FILE`**.
 * `CREATE USER` and `GRANT OPTION` are both static privileges in MySQL 8.0,
 * so both are included, which is precisely what MySQL requires to run
 * `ALTER USER ... WITH MAX_USER_CONNECTIONS` against another account. The
 * statement will work.
 *
 * All static privileges except SUPER and FILE also includes `SELECT`,
 * `INSERT`, `UPDATE`, `DELETE` and `DROP` on `*.*` -- i.e. **on every
 * tenant's logical database**. Stated plainly, because understating it would
 * be the worst possible outcome of this story: *this is a credential that can
 * read, modify and destroy every tenant's data on the shared instance.* It is
 * root-equivalent in every way that matters to a tenant. The only things it
 * cannot do are the two privileges Cloud SQL withholds from everyone
 * including root (SUPER, FILE) and DDL on the `mysql` system database.
 *
 * ----------------------------------------------------------------------------
 * WHY IT IS NOT SCOPED NARROWER, WHICH THE BRIEF ASKED FOR
 * ----------------------------------------------------------------------------
 *
 * The brief's design constraint was "scoped as narrowly as MySQL/Cloud SQL
 * allows for this one job". The honest answer is that **the Cloud SQL Admin
 * API offers no way to do that at creation time**, verified rather than
 * assumed: `gcloud sql users create --help` (run live, 2026-08-05) accepts
 * exactly `--host`, `--password`, `--type` and four password-policy flags.
 * There is no privilege, role, grant or scope argument of any kind. The same
 * is true of `gcp.sql.User`, which wraps that API. Privileges on a Cloud SQL
 * MySQL user are granted and revoked only by `GRANT`/`REVOKE` statements
 * issued over a *SQL connection* -- something no Pulumi GCP resource can do,
 * and something this repo has no provider for (adding `@pulumi/mysql` would
 * mean the Pulumi program itself needing a live network path to the instance
 * on every `pulumi preview`, from CI runners with no stable egress IP, into
 * an instance whose `authorizedNetworks` is deliberately empty).
 *
 * So the narrowing is real in principle, but a live attempt against the
 * production instance on 2026-08-05 found it **is not achievable by any
 * customer-accessible Cloud SQL account** -- this is not a gap in this file,
 * it is a platform limitation, confirmed the hard way. Full incident and
 * evidence: RUNBOOK-bootstrap.md, Part 2. Summary: `REVOKE ALL PRIVILEGES,
 * GRANT OPTION FROM ...` (the form this comment used to recommend) is
 * blocked by Cloud SQL reserving the `sys` schema even from
 * `cloudsqlsuperuser`; revoking the role itself succeeds, but the follow-up
 * `GRANT CREATE USER ON *.* TO ...` then fails, because granting any
 * privilege in MySQL requires holding it `WITH GRANT OPTION`, and no
 * customer-facing account -- root included -- has grant option on anything
 * in Cloud SQL. That sequencing (revoke the wide role, then discover the
 * narrow grant is impossible) left the account holding no privilege at all,
 * a real self-lockout, recovered only by deleting and recreating the account
 * via the Admin API so Google's own provisioning path re-ran.
 *
 * ****************************************************************************
 * DECISION: ACCEPTED AT FULL `cloudsqlsuperuser` BREADTH. NOT A LATER FIX.
 *
 * Narrowing this credential below `cloudsqlsuperuser` is not possible via SQL
 * from any account a customer can reach -- confirmed live, by two independent
 * failure modes, not assumed from documentation. Do not re-attempt the
 * REVOKE/GRANT sequence above; RUNBOOK-bootstrap.md Part 2 documents why it
 * reproduces the same lockout. The credential is accepted, deliberately, at
 * full breadth: it can read, write, or drop any tenant's database.
 *
 * **What makes that acceptable today, and what would make it stop being
 * acceptable:** nothing consumes this credential yet -- no service account
 * has `secretAccessor` on it, no Pulumi program imports it, `index.ts`
 * exports nothing about it. The risk is real but currently unreachable by
 * any running workload. **The first story that wires a consumer to this
 * secret must re-open this decision before doing so** -- worth evaluating
 * then: Cloud SQL IAM database authentication instead of a static
 * password-holding role account, or limiting *when* the credential is
 * reachable (e.g. a short-lived, manually-invoked Cloud Run Job rather than
 * a standing secret a long-running service can read). Do not carry forward
 * "we already decided this is fine" once a consumer exists -- the acceptance
 * here is conditioned on zero consumers, not indefinite.
 *
 * Verification that the account is at its accepted (not locked-out) state is
 * a single read-only query, run any time:
 *
 *     SHOW GRANTS FOR 'ghost_platform_provisioner'@'%';
 *
 * Expected -- exactly two rows:
 *
 *     GRANT USAGE ON *.* TO `ghost_platform_provisioner`@`%`
 *     GRANT `cloudsqlsuperuser`@`%` TO `ghost_platform_provisioner`@`%`
 *
 * One row only (bare `USAGE`) means the account is locked out -- see
 * RUNBOOK-bootstrap.md Part 2 for the recovery command.
 * ****************************************************************************
 *
 * The mitigating facts, none of which change the above: it has no service
 * account consumer and no IAM reader binding (`secrets.ts`), nothing in any
 * Pulumi program imports it, `index.ts` exports nothing about it, and the
 * instance accepts no raw public-IP connections (`database.ts` sets
 * `authorizedNetworks: []`), so possession of the password alone is not
 * sufficient to connect -- a reader also needs `roles/cloudsql.client` and
 * the Cloud SQL Auth Proxy, or `gcloud sql connect`.
 *
 * ----------------------------------------------------------------------------
 * DOES THIS CLOSE `infra/tenant/database.ts`'s GAP? PARTLY -- HERE IS WHAT IS
 * LEFT.
 * ----------------------------------------------------------------------------
 *
 * This story creates the *capability*. It does not connect anything to it.
 * `infra/tenant/database.ts` is untouched and still, correctly, describes
 * MAX_USER_CONNECTIONS as a manual step. What a follow-up story still needs:
 *
 * 1. **Reach the instance.** The Cloud SQL Auth Proxy (or `gcloud sql
 *    connect`) with an identity holding `roles/cloudsql.client` on
 *    `ghost-platform-db`. Note `gcloud sql connect` temporarily adds the
 *    caller's IP to `authorizedNetworks`, which this stack pins to `[]` -- so
 *    a routine `gcloud sql connect` will show up as drift on the next
 *    `pulumi preview` and be reverted by the next apply. The Auth Proxy path
 *    does not have that problem and is the one to build on.
 * 2. **Read the password**: `gcloud secrets versions access latest
 *    --secret=ghost-platform-provisioner-db-password`. Requires
 *    `roles/secretmanager.secretAccessor`, which is granted to nobody by this
 *    program -- a human uses their own project IAM; a future CI job would
 *    need its own explicit binding, added in that story's diff.
 * 3. **Run the statement** `infra/tenant`'s
 *    `maxUserConnectionsStatement` output already produces verbatim, then
 *    `FLUSH PRIVILEGES` is *not* needed (ALTER USER takes effect on the
 *    user's next connection).
 * 4. **Re-open the acceptance decision before wiring any consumer to this
 *    credential.** It is accepted at full `cloudsqlsuperuser` breadth (see
 *    "DECISION" above) precisely because nothing consumes it yet -- that
 *    condition stops being true the moment this follow-up exists. Confirm
 *    `SHOW GRANTS FOR 'ghost_platform_provisioner'@'%';` still shows the
 *    accepted two-row state (not a lockout), and treat "is full-breadth
 *    acceptable now that something reads it" as an open question this
 *    follow-up must answer, not inherit unexamined.
 *
 * ----------------------------------------------------------------------------
 * DELETION AND ROTATION POSTURE
 * ----------------------------------------------------------------------------
 *
 * **No `deletionPolicy: 'ABANDON'`, unlike `infra/tenant/database.ts`'s
 * `gcp.sql.Database`, and no deletion protection, unlike the instance.** That
 * is a considered inversion, not an oversight. Both of those protections
 * exist to stop a routine diff destroying *data*: a dropped tenant database
 * or a deleted instance is unrecoverable customer loss. This resource holds
 * no data. What it holds is standing privileged access, and for that the
 * risks run the other way -- the dangerous outcome is a credential that
 * *survives* being deleted from this program. `ABANDON` would leave a live,
 * fully-privileged MySQL account on the shared instance with its password in
 * a Secret Manager version, referenced by nothing and visible in no Pulumi
 * state: the definition of a forgotten key under the doormat. Removing this
 * block from the program should actually revoke the account. Note this cuts
 * against `scripts/assert-no-platform-deletes.py`'s general posture by
 * design; that script's PROTECTED list is data-bearing resources, and this
 * one is deliberately not on it.
 *
 * **Rotation** is `pulumi up` after bumping `rotationTag` below (or after
 * deleting the `RandomPassword` from state). Since nothing consumes the
 * credential yet, rotation today has no coordination cost; once a runbook or
 * job does consume it, rotation means "re-read the secret", because both the
 * MySQL password and the Secret Manager version update in the same apply.
 *
 * **Rotation is a platform-owner-local apply too, for the same reason creation is.**
 * Changing a Cloud SQL user's password is `cloudsql.users.update`, which --
 * same as `cloudsql.users.create` -- exists only in `roles/cloudsql.admin` and not in
 * the `roles/cloudsql.editor` the deployer holds. So a merged `rotationTag`
 * bump does not rotate anything; it makes the next CI apply 403 until
 * someone runs `pulumi up` locally. Bump it in the same session you intend to
 * apply it, not as a drive-by edit. Note the narrowing survives rotation --
 * `ALTER USER ... IDENTIFIED BY` changes the password, not the grants -- so
 * rotating does not re-open the privileges the runbook revoked.
 */
const provisioningUserPassword = new random.RandomPassword('platform-provisioner-db-password', {
  length: 32,
  special: true,
  // Same character-set reasoning as `infra/tenant/database.ts`: nothing here
  // string-interpolates the value, but this credential is *more* likely than
  // a tenant's to be pasted into an interactive `mysql` client or a shell by
  // a human following a runbook, so quote/backslash/semicolon-shaped
  // characters are worth even more avoiding here than there.
  overrideSpecial: '-_.~',
  keepers: {
    // Bump this string to force a new password on the next `pulumi up`.
    // Explicit and reviewable, rather than rotation-by-accidental-drift.
    rotationTag: '2026-08-05',
  },
});

/**
 * The MySQL account itself. Created through the Cloud SQL Admin API, so it
 * lands with `cloudsqlsuperuser` -- see the privilege analysis above for what
 * that means and why no narrower creation-time option exists.
 */
export const provisioningUser = new gcp.sql.User('platform-provisioner-db-user', {
  name: PROVISIONING_USER_NAME,
  instance: dbInstance.name,
  password: provisioningUserPassword.result,
  // Explicit rather than defaulted. `%` matches `infra/tenant/database.ts`'s
  // tenant users and is required for connections arriving via the Cloud SQL
  // Auth Proxy, which does not present a stable, restrictable client host.
  host: '%',
});

/**
 * The password, in Secret Manager. Never in `Pulumi.platform.yaml`, never in
 * a config value, never exported from `index.ts` -- there is no consumer to
 * export it to, and `index.ts`'s header commits this stack to exporting only
 * what a future story needs to point at.
 */
export const provisioningUserPasswordSecret = secretWithValue(
  'platform-provisioner-db-password-secret',
  PROVISIONING_PASSWORD_SECRET_ID,
  provisioningUserPassword.result,
  // Ordering, not decoration. Without this the secret and the MySQL account
  // are independent leaves of the graph and Pulumi may create the secret
  // first -- so a 403 on `cloudsql.users.create` (the CI failure mode
  // serviceAccounts.ts documents) would leave a password in Secret Manager
  // for an account that does not exist. Harmless but confusing, and the kind
  // of stray state nobody goes back to clean up. This way the secret only
  // ever exists if the account it belongs to does.
  [provisioningUser]
).secret;

/**
 * Exported only so a runbook has a canonical place to read the account name
 * from source. Not exported from `index.ts` -- see above.
 */
export const provisioningUserName = PROVISIONING_USER_NAME;
