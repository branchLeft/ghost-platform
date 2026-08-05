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
 * So the narrowing is real, it is just not something this file can perform.
 * The intended follow-up, stated here so the gap is legible rather than
 * silently accepted: **the first runbook run that uses this credential should
 * begin by narrowing it**, connecting as this user and issuing
 *
 *     REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'ghost_platform_provisioner'@'%';
 *     GRANT CREATE USER ON *.* TO 'ghost_platform_provisioner'@'%';
 *
 * `CREATE USER` is the single MySQL privilege that authorises
 * `ALTER USER ... WITH MAX_USER_CONNECTIONS`, and it grants no data access
 * whatsoever. That is a genuinely narrow credential -- it just has to be
 * reached by self-revocation *after* creation, because the API hands out the
 * wide version first and offers no alternative.
 *
 * ****************************************************************************
 * THE NARROWING IS PART OF CREATING THIS CREDENTIAL, NOT A LATER IMPROVEMENT.
 *
 * Round-2 review was right that an earlier draft of this comment left the
 * REVOKE as aspirational -- something a future story "should" do, with
 * nothing stopping that story from running the ALTER USER it actually wants,
 * deferring the REVOKE, and leaving a full-privilege password in Secret
 * Manager indefinitely. That is a realistic outcome, so the narrowing has
 * moved into the same mandatory, Rob-gated runbook step as the `pulumi up`
 * that creates the account (RUNBOOK-bootstrap.md, "Applying the provisioning
 * credential"). The apply is not finished until the REVOKE has run.
 *
 * **Precondition on every future story: no code, job, runbook or human may
 * treat this credential as safe to reference until the narrowing is verified
 * to have actually run.** Verification is a single read-only query, not a
 * document to trust:
 *
 *     SHOW GRANTS FOR 'ghost_platform_provisioner'@'%';
 *
 * Narrowed, that returns exactly one row:
 *
 *     GRANT CREATE USER ON *.* TO `ghost_platform_provisioner`@`%`
 *
 * Anything else -- in particular a row containing `ALL PRIVILEGES` or the
 * `cloudsqlsuperuser` role -- means the narrowing has not run and the
 * credential is still root-equivalent over every tenant's data. Stop and run
 * it before going further.
 *
 * **Pulumi cannot enforce this, and pretending otherwise would be worse than
 * saying so.** Grants live behind a SQL connection; no `gcp.*` resource and
 * no CI job in this repo has a path to one (see the paragraph above on why
 * `@pulumi/mysql` was rejected). So the honest control is: the narrowing is
 * in the same runbook step as the creation, and the check above is one query
 * anyone can run in ten seconds. Until it has been run, **this credential
 * sits at full cloudsqlsuperuser breadth** -- weigh it on that basis, not on
 * the narrowed end state.
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
 * 4. **Confirm the narrowing already happened** -- `SHOW GRANTS FOR
 *    'ghost_platform_provisioner'@'%';` must return exactly
 *    ``GRANT CREATE USER ON *.* TO `ghost_platform_provisioner`@`%` ``. It is
 *    part of the credential's creation runbook, not this follow-up's job, but
 *    it is this follow-up's job to check rather than assume: if it returns
 *    anything wider, the credential is still root-equivalent and must be
 *    narrowed before anything is wired to it.
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
 * **Rotation is a Rob-local apply too, for the same reason creation is.**
 * Changing a Cloud SQL user's password is `cloudsql.users.update`, which --
 * verified against the live role definitions, same check as
 * `cloudsql.users.create` -- exists only in `roles/cloudsql.admin` and not in
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
