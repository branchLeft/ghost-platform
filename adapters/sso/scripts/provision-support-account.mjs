#!/usr/bin/env node
// The provisioning step LLD-5 §07 leaves open how the staff row is created:
// Ghost's normal route to a new staff account is an emailed invite, and a
// tenant with no working mail yet cannot complete one. This writes the row
// directly into the tenant's own Ghost database instead, through the
// tenant's already-running container, using whichever DB driver Ghost
// itself has installed -- never a driver of this script's own, and never a
// credential this script reads itself: connection details come from the
// container's own environment, exactly as `render-core` rendered them.
//
// Usage:
//   node provision-support-account.mjs --container <name> --email <address>
//
// Idempotent: a second run against the same container is a no-op when the
// row is already complete -- it never re-suspends an account a tenant has
// since granted, and never mints a second unusable password for the same
// email. A row missing its Administrator link (a partial write) is
// repaired, never silently skipped -- see `administratorRoleLinkFor` in the
// inner script below. The account this script creates is ALWAYS suspended
// (Ghost's own "inactive" status); nothing here accepts a flag to create
// one active, which is the one thing this component's own sabotage exists
// to catch if it is ever added back in.
//
// The user row and its Administrator link are written inside one
// transaction (`inTransaction` below), for both database backends, so a
// `docker exec` killed mid-write leaves either both rows or neither --
// never the partial state the repair path above exists to recover from on
// a row written before this fix, or by anything else.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Ghost's own storage value for "suspended" -- see `adapters/sso/README.md`
 * and the design's own measured finding on account suspension. */
export const SUSPENDED_STATUS = 'inactive';

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
 * The inline script run *inside* the tenant's own container, exactly the
 * pattern `break-glass.image.test.mjs`'s own `sql()`/`createSupportUser`
 * helpers already use to reach Ghost's own installed database driver
 * without this repo taking a dependency of its own on either one. It never
 * runs as a `node -e` invocation from this session's own shell -- only as
 * an argument this script hands to `docker exec` at run time, from inside
 * an already-vetted file.
 *
 * `EMAIL`/`ID`/`PASSWORD_HASH`/`NOW` arrive as env vars on the `docker exec`
 * call, never interpolated into the script text itself -- the same reason
 * `render-core`'s own shell-quoting exists: a value is data, never syntax.
 */
const INNER_SCRIPT = `
const isSqlite = process.env.database__client === 'sqlite3';
function req(name) {
  return require(require.resolve(name, { paths: ['/var/lib/ghost/current'] }));
}
function connect() {
  if (isSqlite) {
    const Database = req('better-sqlite3');
    const db = new Database(process.env.database__connection__filename);
    return {
      get: (sql, params) => db.prepare(sql).get(...params),
      run: (sql, params) => db.prepare(sql).run(...params),
    };
  }
  const mysql = req('mysql2');
  const conn = mysql.createConnection({
    host: process.env.database__connection__host,
    port: Number(process.env.database__connection__port),
    database: process.env.database__connection__database,
    user: process.env.database__connection__user,
    password: process.env.database__connection__password,
  });
  return {
    get: (sql, params) => {
      const [rows] = conn.execute(sql, params);
      return rows[0];
    },
    run: (sql, params) => conn.execute(sql, params),
  };
}
async function administratorRoleLinkFor(db, userId) {
  return db.get(
    \`select r.id from roles r
       join roles_users ru on ru.role_id = r.id
      where ru.user_id = ? and r.name = 'Administrator'\`,
    [userId]
  );
}
async function inTransaction(db, body) {
  await db.run('begin', []);
  try {
    const result = await body();
    await db.run('commit', []);
    return result;
  } catch (error) {
    await db.run('rollback', []);
    throw error;
  }
}
async function main() {
  const db = connect();
  const email = process.env.PROVISION_SUPPORT_EMAIL;
  const existing = await db.get('select id, status from users where email = ?', [email]);
  if (existing) {
    const link = await administratorRoleLinkFor(db, existing.id);
    if (link) {
      console.log(
        JSON.stringify({ created: false, repaired: false, id: existing.id, status: existing.status })
      );
      return;
    }
    // A partial row: the user exists but the Administrator link never
    // landed -- the two inserts used to be two separate statements with no
    // transaction between them (fixed below for a fresh create), and a row
    // written before that fix, or by anything else, can still be in this
    // state. Repaired, never skipped: status is left exactly as found,
    // because a status change since creation is a tenant's own grant, never
    // something this script infers or corrects.
    const role = await db.get("select id from roles where name = 'Administrator'", []);
    await inTransaction(db, () =>
      db.run('insert into roles_users (id, role_id, user_id) values (?, ?, ?)', [
        process.env.PROVISION_SUPPORT_ROLE_LINK_ID,
        role.id,
        existing.id,
      ])
    );
    console.log(
      JSON.stringify({ created: false, repaired: true, id: existing.id, status: existing.status })
    );
    return;
  }
  const id = process.env.PROVISION_SUPPORT_ID;
  const passwordHash = process.env.PROVISION_SUPPORT_PASSWORD_HASH;
  const now = process.env.PROVISION_SUPPORT_NOW;
  const role = await db.get("select id from roles where name = 'Administrator'", []);
  await inTransaction(db, async () => {
    await db.run(
      \`insert into users (id, name, slug, password, email, status, visibility,
        comment_notifications, free_member_signup_notification,
        paid_subscription_started_notification, paid_subscription_canceled_notification,
        mention_notifications, recommendation_notifications, milestone_notifications,
        donation_notifications, gift_subscription_notifications, created_at)
       values (?, ?, ?, ?, ?, ?, 'public', 1, 1, 1, 1, 1, 1, 1, 1, 1, ?)\`,
      [id, '${STAFF_NAME}', '${STAFF_SLUG}', passwordHash, email, 'inactive', now]
    );
    await db.run('insert into roles_users (id, role_id, user_id) values (?, ?, ?)', [
      process.env.PROVISION_SUPPORT_ROLE_LINK_ID,
      role.id,
      id,
    ]);
  });
  console.log(JSON.stringify({ created: true, repaired: false, id, status: 'inactive' }));
}
main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
`;

/**
 * Creates the suspended support account inside `container`'s own Ghost
 * database, atomically; repairs a pre-existing row missing its
 * Administrator link; or reports a pre-existing, already-complete row
 * untouched. Always inserts as `inactive` -- see this module's own doc
 * comment for why there is no way to ask for anything else. Returns
 * `{created, repaired, id, status}`: `created` and `repaired` are never
 * both true.
 */
export function provisionSupportAccount({ container, email }, execFile = execFileSync) {
  const env = [
    `PROVISION_SUPPORT_EMAIL=${email}`,
    `PROVISION_SUPPORT_ID=${ghostObjectId()}`,
    `PROVISION_SUPPORT_PASSWORD_HASH=${unusablePasswordHash()}`,
    `PROVISION_SUPPORT_ROLE_LINK_ID=${ghostObjectId()}`,
    `PROVISION_SUPPORT_NOW=${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
  ];
  const args = [
    'exec',
    ...env.flatMap((pair) => ['-e', pair]),
    container,
    'node',
    '-e',
    INNER_SCRIPT,
  ];
  const output = execFile('docker', args, { encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').pop());
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = provisionSupportAccount(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
