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
async function connect() {
  if (isSqlite) {
    const Database = req('better-sqlite3');
    const db = new Database(process.env.database__connection__filename);
    return {
      get: (sql, params) => db.prepare(sql).get(...params),
      run: (sql, params) => db.prepare(sql).run(...params),
      // BEGIN/COMMIT/ROLLBACK are statement text, not parameterised
      // queries -- exec(), not prepare().run(), matches that shape.
      begin: () => db.exec('BEGIN'),
      commit: () => db.exec('COMMIT'),
      rollback: () => db.exec('ROLLBACK'),
      close: () => db.close(),
    };
  }
  // mysql2's own prepared-statement path (.execute(), the binary protocol)
  // does not accept transaction-control statements -- mysql2's own
  // beginTransaction()/commit()/rollback() route through .query() (the text
  // protocol) instead, and this uses those same driver-native methods
  // rather than re-deriving the distinction with raw SQL. mysql2/promise
  // (not the callback-style base export) is what makes createConnection and
  // every method below return a promise this script can await.
  const mysql = req('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.database__connection__host,
    port: Number(process.env.database__connection__port),
    database: process.env.database__connection__database,
    user: process.env.database__connection__user,
    password: process.env.database__connection__password,
  });
  return {
    get: async (sql, params) => {
      const [rows] = await conn.execute(sql, params);
      return rows[0];
    },
    run: (sql, params) => conn.execute(sql, params),
    begin: () => conn.beginTransaction(),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    close: () => conn.end(),
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
async function anyRoleLinkFor(db, userId) {
  return db.get('select 1 as x from roles_users where user_id = ?', [userId]);
}
async function inTransaction(db, body) {
  await db.begin();
  try {
    const result = await body();
    await db.commit();
    return result;
  } catch (error) {
    await db.rollback();
    throw error;
  }
}
async function main() {
  const db = await connect();
  try {
    const email = process.env.PROVISION_SUPPORT_EMAIL;
    const existing = await db.get('select id, status from users where email = ?', [email]);
    if (existing) {
      const adminLink = await administratorRoleLinkFor(db, existing.id);
      if (adminLink) {
        console.log(
          JSON.stringify({ created: false, repaired: false, id: existing.id, status: existing.status })
        );
        return;
      }
      // Repairable only when the row is EXACTLY the shape this script's own
      // interrupted create leaves: still suspended, and no role link of any
      // kind (never merely "no Administrator link" -- a user with some
      // other role linked, or an active user with none, reached this state
      // by a path other than an interrupted run of this script, and
      // granting Administrator to it here would be an ungoverned permission
      // grant this script has no business making).
      const anyLink = await anyRoleLinkFor(db, existing.id);
      if (existing.status !== '${SUSPENDED_STATUS}' || anyLink) {
        throw new Error(
          '${PARTIAL_ROW_MISMATCH_MARKER}' + JSON.stringify({
            id: existing.id,
            status: existing.status,
            hasRoleLink: Boolean(anyLink),
          }) + ' does not match an interrupted create (needs status "${SUSPENDED_STATUS}" and no role link at all)'
        );
      }
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
        [id, '${STAFF_NAME}', '${STAFF_SLUG}', passwordHash, email, '${SUSPENDED_STATUS}', now]
      );
      await db.run('insert into roles_users (id, role_id, user_id) values (?, ?, ?)', [
        process.env.PROVISION_SUPPORT_ROLE_LINK_ID,
        role.id,
        id,
      ]);
    });
    console.log(JSON.stringify({ created: true, repaired: false, id, status: '${SUSPENDED_STATUS}' }));
  } finally {
    await db.close();
  }
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
  let output;
  try {
    output = execFile('docker', args, { encoding: 'utf8' });
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const markerIndex = stderr.indexOf(PARTIAL_ROW_MISMATCH_MARKER);
    if (markerIndex !== -1) {
      throw new PartialRowMismatchError(
        stderr.slice(markerIndex + PARTIAL_ROW_MISMATCH_MARKER.length).split('\n')[0].trim()
      );
    }
    throw error;
  }
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
