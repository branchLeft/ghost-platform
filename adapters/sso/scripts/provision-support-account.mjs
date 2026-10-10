#!/usr/bin/env node
// Writes the support staff row directly into the tenant's own Ghost
// database, through the tenant's running container, because a tenant with
// no working mail yet cannot complete Ghost's normal invite-email route.
// See provision-support-account.md for the usage, the idempotency and
// repair rules, and the transaction and TLS requirements.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Ghost's own storage value for "suspended" -- see `adapters/sso/README.md`
 * and the design's own measured finding on account suspension. */
export const SUSPENDED_STATUS = 'inactive';

/**
 * Marks a refusal from inside the inner script's stderr as a named,
 * distinguishable failure -- a row that is not this script's own
 * interrupted write -- rather than an ordinary crash. `provisionSupportAccount`
 * below matches on this exact prefix to re-throw `PartialRowMismatchError`
 * in this process, since a thrown class instance cannot cross the
 * `docker exec` subprocess boundary itself.
 */
const PARTIAL_ROW_MISMATCH_MARKER = 'PARTIAL_ROW_MISMATCH: ';

/**
 * The row found for this email is not the shape a genuinely-interrupted
 * create of this script's own leaves (status `inactive`, no role link at
 * all) -- so repairing it would grant Administrator to a row this script
 * never atomically started, including one already made active by some
 * other path. Refused rather than repaired; nothing is written.
 */
export class PartialRowMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PartialRowMismatchError';
  }
}

/** See `PARTIAL_ROW_MISMATCH_MARKER`'s own comment -- the same
 * can't-cross-`docker-exec`-boundary reason applies here. */
const ACTIVE_EXISTING_ROW_MARKER = 'ACTIVE_EXISTING_ROW: ';

/**
 * D12 (this component's load-bearing mark, see `provision-support-
 * account.image.test.mjs`'s SABOTAGE case): the support account is
 * suspended at rest. A pre-existing row for this email that already
 * carries Administrator and is NOT suspended did not reach that state
 * through this script -- reporting it as a successful provisioning would
 * let a caller mistake an already-live grant for the suspended resting
 * state D12 requires. Refused rather than reported; nothing is written.
 */
export class ActiveExistingRowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActiveExistingRowError';
  }
}

const STAFF_NAME = 'Support';
const STAFF_SLUG = 'support';

/**
 * A bcrypt-*shaped* string over random bytes -- never a hash of anything a
 * human chose or could choose, and never run through a real bcrypt (there
 * is nothing to verify, since Ghost's own suspension check refuses the
 * account before any password comparison runs -- see `break-glass.image.
 * test.mjs`'s own `createSupportUser`, which this mirrors). `$2a$10$`
 * matches bcrypt's own encoded prefix so the column holds a value of the
 * shape Ghost's schema expects, not a value Ghost would ever accept as a
 * real hash of a guessable password.
 */
export function unusablePasswordHash() {
  const body = randomBytes(40)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 53);
  return `$2a$10$${body}`;
}

/** A Ghost object id: 24 lowercase hex characters, matching every id
 * `break-glass.image.test.mjs` mints the same way. */
export function ghostObjectId() {
  return randomBytes(12).toString('hex');
}

export function parseArgs(argv) {
  const args = { container: null, email: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--container') {
      args.container = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--email') {
      args.email = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unrecognised argument: ${argv[i]}`);
    }
  }
  if (!args.container) {
    throw new Error('--container <name> is required');
  }
  if (!args.email) {
    throw new Error('--email <address> is required');
  }
  return args;
}

/**
 * The inline script run *inside* the tenant's own container via `docker
 * exec`, never invoked directly from this shell. Values arrive as env vars,
 * never interpolated into the script text. See
 * provision-support-account.md#inner-script.
 */
const INNER_SCRIPT = `
// Ghost's own knex instance, configured from Ghost's own config exactly as the
// running Ghost is. See provision-support-account.md#inner-script.
const knex = require('/var/lib/ghost/current/core/server/data/db/connection.js');
const isSqlite = ['sqlite3', 'better-sqlite3'].includes(knex.client.config.client);
function administratorRoleLinkFor(trx, userId) {
  return trx('roles')
    .join('roles_users', 'roles_users.role_id', 'roles.id')
    .where('roles_users.user_id', userId)
    .andWhere('roles.name', 'Administrator')
    .first('roles.id');
}
function anyRoleLinkFor(trx, userId) {
  return trx('roles_users').where('user_id', userId).first('id');
}
function administratorRole(trx) {
  return trx('roles').where('name', 'Administrator').first('id');
}
async function main() {
  try {
    const email = process.env.PROVISION_SUPPORT_EMAIL;
    // The repair-or-refuse read and the Administrator grant share one
    // transaction, row-locked on MySQL. See provision-support-account.md#inner-script.
    const existingOutcome = await knex.transaction(async (trx) => {
      const existing = await trx('users')
        .where('email', email)
        .modify((query) => {
          if (!isSqlite) query.forUpdate();
        })
        .first('id', 'status');
      if (!existing) {
        return null;
      }
      const adminLink = await administratorRoleLinkFor(trx, existing.id);
      if (adminLink) {
        // An active Administrator row is never reported as a successful provisioning.
        if (existing.status !== '${SUSPENDED_STATUS}') {
          throw new Error(
            '${ACTIVE_EXISTING_ROW_MARKER}' + JSON.stringify({
              id: existing.id,
              status: existing.status,
            }) + ' an existing Administrator row for this email is not suspended -- refusing to report provisioning as successful'
          );
        }
        return { created: false, repaired: false, id: existing.id, status: existing.status };
      }
      // Repairable only in the exact shape an interrupted create leaves.
      const anyLink = await anyRoleLinkFor(trx, existing.id);
      if (existing.status !== '${SUSPENDED_STATUS}' || anyLink) {
        throw new Error(
          '${PARTIAL_ROW_MISMATCH_MARKER}' + JSON.stringify({
            id: existing.id,
            status: existing.status,
            hasRoleLink: Boolean(anyLink),
          }) + ' does not match an interrupted create (needs status "${SUSPENDED_STATUS}" and no role link at all)'
        );
      }
      const role = await administratorRole(trx);
      await trx('roles_users').insert({
        id: process.env.PROVISION_SUPPORT_ROLE_LINK_ID,
        role_id: role.id,
        user_id: existing.id,
      });
      return { created: false, repaired: true, id: existing.id, status: existing.status };
    });
    if (existingOutcome) {
      console.log(JSON.stringify(existingOutcome));
      return;
    }
    const id = process.env.PROVISION_SUPPORT_ID;
    const role = await administratorRole(knex);
    await knex.transaction(async (trx) => {
      await trx('users').insert({
        id,
        name: '${STAFF_NAME}',
        slug: '${STAFF_SLUG}',
        password: process.env.PROVISION_SUPPORT_PASSWORD_HASH,
        email,
        status: '${SUSPENDED_STATUS}',
        visibility: 'public',
        comment_notifications: 1,
        free_member_signup_notification: 1,
        paid_subscription_started_notification: 1,
        paid_subscription_canceled_notification: 1,
        mention_notifications: 1,
        recommendation_notifications: 1,
        milestone_notifications: 1,
        donation_notifications: 1,
        gift_subscription_notifications: 1,
        created_at: process.env.PROVISION_SUPPORT_NOW,
      });
      await trx('roles_users').insert({
        id: process.env.PROVISION_SUPPORT_ROLE_LINK_ID,
        role_id: role.id,
        user_id: id,
      });
    });
    console.log(JSON.stringify({ created: true, repaired: false, id, status: '${SUSPENDED_STATUS}' }));
  } finally {
    await knex.destroy();
  }
}
main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
`;

/**
 * Creates the suspended support account inside `container`'s own Ghost
 * database, atomically; repairs a partial row; or reports an existing
 * suspended row untouched. Throws `ActiveExistingRowError` if an existing
 * row is not suspended. Returns `{created, repaired, id, status}` (`created`
 * and `repaired` are never both true). See
 * provision-support-account.md#provisionsupportaccount.
 */
export function provisionSupportAccount({ container, email }, execFile = execFileSync) {
  const args = [
    'exec',
    ...provisionEnv(email).flatMap((pair) => ['-e', pair]),
    container,
    'node',
    '-e',
    INNER_SCRIPT,
  ];
  let output;
  try {
    output = execFile('docker', args, { encoding: 'utf8' });
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    throw typedFailure(stderr) ?? error;
  }
  return JSON.parse(output.trim().split('\n').pop());
}

/**
 * The same provisioning through a Docker Engine client (`exec({container,
 * cmd, env})` resolving `{code, stdout, stderr}`), for a caller with no
 * docker CLI. The inner script, the markers and the results are the ones
 * `provisionSupportAccount` uses.
 */
export async function provisionSupportAccountViaEngine({ container, email }, engine) {
  const { code, stdout, stderr } = await engine.exec({
    container,
    env: provisionEnv(email),
    cmd: ['node', '-e', INNER_SCRIPT],
  });
  if (code !== 0) {
    throw (
      typedFailure(stderr) ??
      new Error(`provisioning exited ${code}: ${stderr.trim().slice(0, 600)}`)
    );
  }
  return JSON.parse(stdout.trim().split('\n').pop());
}

function provisionEnv(email) {
  return [
    `PROVISION_SUPPORT_EMAIL=${email}`,
    `PROVISION_SUPPORT_ID=${ghostObjectId()}`,
    `PROVISION_SUPPORT_PASSWORD_HASH=${unusablePasswordHash()}`,
    `PROVISION_SUPPORT_ROLE_LINK_ID=${ghostObjectId()}`,
    `PROVISION_SUPPORT_NOW=${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
  ];
}

/** The named refusal in the inner script's stderr, or null when it is neither. */
function typedFailure(stderr) {
  const firstLine = (marker, at) =>
    stderr
      .slice(at + marker.length)
      .split('\n')[0]
      .trim();
  const partialIndex = stderr.indexOf(PARTIAL_ROW_MISMATCH_MARKER);
  if (partialIndex !== -1) {
    return new PartialRowMismatchError(firstLine(PARTIAL_ROW_MISMATCH_MARKER, partialIndex));
  }
  const activeIndex = stderr.indexOf(ACTIVE_EXISTING_ROW_MARKER);
  if (activeIndex !== -1) {
    return new ActiveExistingRowError(firstLine(ACTIVE_EXISTING_ROW_MARKER, activeIndex));
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = provisionSupportAccount(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
