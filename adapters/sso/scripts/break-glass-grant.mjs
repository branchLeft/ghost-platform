#!/usr/bin/env node
// The two grant lanes and the four-hour clock, run as root on the tenant's
// own host, in the pinned Node container the host wrapper and the expire unit
// start. A person runs grant and revoke over SSH; a systemd timer runs
// expire every minute. See break-glass-grant.md for the lanes, the clock,
// the double purge, the container and the records this writes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createEngine, DOCKER_TIMEOUT_MS } from './docker-engine.mjs';
import {
  ActiveExistingRowError,
  provisionSupportAccountViaEngine,
} from './provision-support-account.mjs';

export { DOCKER_TIMEOUT_MS };

export const GRANT_STATE_DIRECTORY = '/var/lib/branchleft/break-glass-grants';
export const GRANT_RECORD_LOG = '/var/log/branchleft/break-glass-grants.jsonl';
export const EXPIRE_TIMER_UNIT = 'branchleft-break-glass-expire.timer';
/** Owner ruling D13: four hours. Incidental, so a constant, never a flag. */
export const GRANT_WINDOW_SECONDS = 4 * 60 * 60;
/** Requirement 1 of the adapter review: purge, wait a few seconds, purge again. */
export const SECOND_PURGE_DELAY_MS = 5000;
/**
 * The wrapper passes the host's own answer to `systemctl is-active` in here,
 * because the container cannot ask systemd. Anything but `active` refuses a grant.
 */
export const TIMER_STATE_ENV = 'BL_EXPIRE_TIMER_STATE';
/** The one Compose label the tenant's containers carry, and the two services. */
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const LANES = ['consented', 'incident'];
const GHOST_SERVICES = ['ghost-a', 'ghost-b'];
const ONE_LINE = /^[\x21-\x7e][\x20-\x7e]{0,199}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IDENTITY = /^[^\s@]+@[^\s@]+$/;
const RESULT_MARKER = 'BL_BREAK_GLASS ';
const REFUSAL_MARKER = 'BL_BREAK_GLASS_REFUSED ';

export class GrantRefusedError extends Error {
  constructor(message) {
    super(`refused: ${message}`);
    this.name = 'GrantRefusedError';
  }
}

export class StateUnreadableError extends Error {
  constructor(tenant, detail) {
    super(`the grant state for ${tenant} is unreadable (${detail})`);
    this.name = 'StateUnreadableError';
  }
}

export function parseGrantArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!/^--(lane|tenant|identity|reason|reference)$/.test(name) || rest[i + 1] === undefined) {
      throw new GrantRefusedError(`unrecognised or valueless argument: ${name}`);
    }
    flags[name.slice(2)] = rest[i + 1];
  }
  const allowed = {
    grant: { needs: ['lane', 'tenant', 'reason', 'reference'], may: ['identity'] },
    revoke: { needs: ['tenant', 'reason'], may: [] },
    expire: { needs: [], may: [] },
    status: { needs: [], may: [] },
  }[command];
  if (!allowed) {
    throw new GrantRefusedError('the command must be grant, revoke, expire or status');
  }
  const extra = Object.keys(flags).filter(
    (name) => !allowed.needs.includes(name) && !allowed.may.includes(name)
  );
  if (extra.length > 0) {
    throw new GrantRefusedError(`${command} does not take --${extra.join(', --')}`);
  }
  for (const name of allowed.needs) {
    if (flags[name] === undefined) throw new GrantRefusedError(`${command} needs --${name}`);
  }
  if (flags.lane !== undefined && !LANES.includes(flags.lane)) {
    throw new GrantRefusedError(`--lane must be one of ${LANES.join(', ')}`);
  }
  if (flags.tenant !== undefined && !TENANT.test(flags.tenant)) {
    throw new GrantRefusedError('--tenant must be the tenant slug');
  }
  if (flags.identity !== undefined && !IDENTITY.test(flags.identity)) {
    throw new GrantRefusedError('--identity must be an email address');
  }
  for (const name of ['reason', 'reference']) {
    if (flags[name] !== undefined && !ONE_LINE.test(flags[name])) {
      throw new GrantRefusedError(`--${name} must be one printable line of 1-200 characters`);
    }
  }
  return { command, ...flags };
}

/**
 * Runs inside the tenant's running Ghost container, through Ghost's own config
 * and knex. The account it acts on is the supportIdentity in the tenant's own
 * config, never a value from outside. See break-glass-grant.md#the-account.
 */
export const INNER_SCRIPT = `
process.chdir('/var/lib/ghost');
const config = require('/var/lib/ghost/current/core/shared/config');
const knex = require('/var/lib/ghost/current/core/server/data/db/connection.js');
const isSqlite = ['sqlite3', 'better-sqlite3'].includes(knex.client.config.client);
const ACTIVE = ['active', 'warn-1', 'warn-2', 'warn-3', 'warn-4'];
const refuse = (message) => { throw new Error('${REFUSAL_MARKER}' + message); };
async function account(trx, email) {
  const user = await trx('users').where('email', email)
    .modify((q) => { if (!isSqlite) q.forUpdate(); }).first('id', 'status');
  if (!user) return null;
  const roles = (await trx('roles').join('roles_users', 'roles_users.role_id', 'roles.id')
    .where('roles_users.user_id', user.id).select('roles.name')).map((r) => r.name);
  return { ...user, roles };
}
const onlyAdministrator = (a) => a.roles.length === 1 && a.roles[0] === 'Administrator';
async function main() {
  const action = process.env.BL_ACTION;
  const expected = process.env.BL_EXPECT_IDENTITY;
  try {
    const email = config.get('adapters:sso:BreakGlassSSO:supportIdentity');
    if (typeof email !== 'string' || email.length === 0) {
      refuse('this tenant has no break-glass supportIdentity in its config');
    }
    if (expected && expected !== email) {
      refuse(expected + ' is not this tenant\\'s configured support identity');
    }
    const result = await knex.transaction(async (trx) => {
      if (action === 'identity') return { identity: email };
      const a = await account(trx, email);
      if (action === 'check') {
        if (!a) refuse('the support account does not exist; the tenant deleted it');
        if (!onlyAdministrator(a)) refuse('the account is not the support Administrator');
        if (!ACTIVE.includes(a.status)) refuse('the tenant has not un-suspended the support account (status ' + a.status + ')');
        return { identity: email, id: a.id, previousStatus: a.status };
      }
      if (action === 'activate') {
        if (!a) return { identity: email, absent: true };
        if (!onlyAdministrator(a)) refuse('the account is not the support Administrator');
        await trx('users').where('id', a.id).update({ status: 'active' });
        return { identity: email, id: a.id, previousStatus: a.status };
      }
      if (action === 'revoke') {
        if (!a) return { identity: email, found: false, sessionsPurged: 0 };
        if (a.roles.includes('Owner')) refuse('the account holds the Owner role; it is never suspended');
        await trx('users').where('id', a.id).update({ status: 'inactive' });
        const purged = await trx('sessions').where('user_id', a.id).del();
        return { identity: email, found: true, id: a.id, previousStatus: a.status, sessionsPurged: purged };
      }
      refuse('unknown action');
    });
    console.log('${RESULT_MARKER}' + JSON.stringify(result));
  } finally {
    await knex.destroy();
  }
}
main().catch((error) => { console.error(String(error && error.message)); process.exitCode = 1; });
`;

/** The tenant's running Ghost container: either colour, both share one database. */
export async function findTenantContainer(tenant, engine = createEngine()) {
  const found = await engine.listContainers({ labels: { [PROJECT_LABEL]: tenant } });
  const names = found
    .filter(
      (c) =>
        c.labels?.[PROJECT_LABEL] === tenant && GHOST_SERVICES.includes(c.labels?.[SERVICE_LABEL])
    )
    .map((c) => c.name)
    .sort();
  if (names.length === 0) {
    throw new GrantRefusedError(`no running Ghost container for tenant ${tenant}`);
  }
  return names[0];
}

/** Runs one ACTION in the container and returns its JSON result. */
export async function runInContainer({ container, action, expect }, engine = createEngine()) {
  const env = [`BL_ACTION=${action}`];
  if (expect) env.push(`BL_EXPECT_IDENTITY=${expect}`);
  const { code, stdout, stderr } = await engine.exec({
    container,
    env,
    cmd: ['node', '-e', INNER_SCRIPT],
  });
  if (code !== 0) {
    const at = stderr.indexOf(REFUSAL_MARKER);
    if (at !== -1) {
      throw new GrantRefusedError(
        stderr
          .slice(at + REFUSAL_MARKER.length)
          .split('\n')[0]
          .trim()
      );
    }
    throw new Error(`exec ${action} failed (exit ${code}): ${stderr.trim().slice(0, 600)}`);
  }
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`docker exec ${action} printed no result`);
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

/** True only when the wrapper said the host's expire timer is active. */
export function timerReportedActive(env = process.env) {
  return env[TIMER_STATE_ENV] === 'active';
}

/** Production wiring. Tests replace any of these. */
export function defaultDeps({ env = process.env, ...engineOptions } = {}) {
  const engine = createEngine(engineOptions);
  return {
    stateDir: GRANT_STATE_DIRECTORY,
    recordLog: GRANT_RECORD_LOG,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => process.stderr.write(`break-glass-grant: ${message}\n`),
    timerActive: () => timerReportedActive(env),
    findContainer: (tenant) => findTenantContainer(tenant, engine),
    run: (request) => runInContainer(request, engine),
    recreate: ({ container, identity }) => recreateIfDeleted({ container, identity }, engine),
    betweenPurges: async () => {},
  };
}

/**
 * Provisions the account when the tenant deleted it, bounded by the Engine
 * client's timeout. An account already present and active is not an error.
 */
export async function recreateIfDeleted(
  { container, identity },
  engine = createEngine(),
  provision = provisionSupportAccountViaEngine
) {
  try {
    return await provision({ container, email: identity }, engine);
  } catch (error) {
    if (error instanceof ActiveExistingRowError) return { created: false };
    throw error;
  }
}

const statePath = (deps, tenant) => path.join(deps.stateDir, `${tenant}.json`);

/** Null when there is no grant; StateUnreadableError for anything malformed. */
function readGrant(deps, tenant) {
  let text;
  try {
    text = fs.readFileSync(statePath(deps, tenant), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !entryExists(statePath(deps, tenant))) return null;
    throw new StateUnreadableError(tenant, error.code ?? error.message);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new StateUnreadableError(tenant, 'not JSON');
  }
  if (
    !state ||
    typeof state !== 'object' ||
    typeof state.deadline !== 'string' ||
    Number.isNaN(Date.parse(state.deadline))
  ) {
    throw new StateUnreadableError(tenant, 'no valid deadline');
  }
  return state;
}

/** True for any directory entry, including a symlink whose target is missing. */
function entryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Names one grant: inode plus raw content (which carries the grant id), or
 * null when there is no entry. An unreadable entry is named by its inode.
 */
export function stateFingerprint(deps, tenant) {
  return fingerprintFile(statePath(deps, tenant));
}

function fingerprintFile(file) {
  let inode;
  try {
    inode = fs.lstatSync(file).ino;
  } catch {
    return null;
  }
  let text = 'unreadable';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // named by the inode alone
  }
  return `${inode}:${text}`;
}

/** A claim younger than this may belong to a close still running, so expire leaves it. */
export const CLAIM_GRACE_MS = 60 * 1000;
const CLAIM_NAME = /^\.([a-z0-9][a-z0-9-]{0,62})\.\d+\.[0-9a-f]{12}\.claim$/;

/** A different grant's state could not be put back; it is kept in a claim file. */
export class StateHeldError extends Error {
  constructor(tenant, claimName, detail) {
    super(
      `the newer grant state for ${tenant} could not be restored (${detail}); ` +
        `it is held in ${claimName} until expire puts it back or closes it at its deadline`
    );
    this.name = 'StateHeldError';
  }
}

/**
 * Removes the state only if it is still the grant that was read: renamed to a
 * private claim name (atomic), compared, and a different grant linked back.
 * No lock is taken. A failed link back keeps the claim and throws, so a newer
 * grant's state is never dropped without a copy that expire finds.
 */
export function removeStateIfSame(deps, tenant, fingerprint, log = deps.log) {
  if (fingerprint === null) return false;
  const file = statePath(deps, tenant);
  const claimName = `.${tenant}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.claim`;
  const claim = path.join(deps.stateDir, claimName);
  try {
    fs.renameSync(file, claim);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const same = fingerprintFile(claim) === fingerprint;
  if (!same) restoreClaim(claim, file, tenant, claimName, log);
  fs.rmSync(claim, { force: true, recursive: true });
  return same;
}

/** True when both names are the same file, so linking one to the other changes nothing. */
function sameFile(a, b) {
  try {
    const first = fs.lstatSync(a);
    const second = fs.lstatSync(b);
    return first.ino === second.ino && first.dev === second.dev;
  } catch {
    return false;
  }
}

/**
 * Links a claimed state back and returns what happened: restored, present
 * (the state already is this file) or gone (another process reclaimed it).
 * Anything else throws with the claim kept, including a different grant in
 * place: its deadline need not be the claimed grant's, so the claim stays held.
 */
function restoreClaim(claim, file, tenant, claimName, log) {
  try {
    fs.linkSync(claim, file);
    return 'restored';
  } catch (error) {
    if (error.code === 'EEXIST' && sameFile(claim, file)) return 'present';
    if (error.code === 'ENOENT' && !entryExists(claim)) return 'gone';
    const held = new StateHeldError(tenant, claimName, error.code ?? error.message);
    log(held.message);
    throw held;
  }
}

function claimNames(deps) {
  try {
    return fs.readdirSync(deps.stateDir).filter((n) => CLAIM_NAME.test(n));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const claimsFor = (deps, tenant) =>
  claimNames(deps).filter((name) => CLAIM_NAME.exec(name)[1] === tenant);

/** Reads a claim file's grant state, or null when it is not valid JSON. */
function readClaim(deps, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(deps.stateDir, name), 'utf8'));
  } catch {
    return null;
  }
}

/** No readable deadline, or one that has passed: the grant is closed at once. */
function claimIsDue(deps, name) {
  const state = readClaim(deps, name);
  const deadline = typeof state?.deadline === 'string' ? Date.parse(state.deadline) : NaN;
  return Number.isNaN(deadline) || deadline <= deps.now();
}

/**
 * Puts leftover claims back so their grants are tracked again: one held after
 * a failed link back, or left by a process killed mid-claim. A claim younger
 * than the grace period may belong to a close still running, so it is skipped.
 * One that cannot be put back is closed at its deadline, like any other grant.
 */
async function reclaimClaims(deps) {
  const closed = [];
  const failed = [];
  for (const name of claimNames(deps)) {
    const claim = path.join(deps.stateDir, name);
    const tenant = CLAIM_NAME.exec(name)[1];
    let failure = null;
    try {
      if (deps.now() - fs.statSync(claim).ctimeMs < CLAIM_GRACE_MS) continue;
      const outcome = restoreClaim(claim, statePath(deps, tenant), tenant, name, deps.log);
      fs.rmSync(claim, { force: true });
      if (outcome === 'restored') deps.log(`put back the held grant state for ${tenant}`);
    } catch (error) {
      failure = error;
    }
    if (failure?.code === 'ENOENT') continue; // reclaimed since the listing
    if (failure instanceof StateHeldError && claimIsDue(deps, name)) {
      try {
        // The closing record comes first; revoke then drops this claim.
        closed.push(
          await revoke({ tenant, reason: 'four-hour window ended', cause: 'timer' }, deps)
        );
        failure = null;
      } catch (error) {
        failure = error;
      }
    }
    if (failure) {
      if (!(failure instanceof StateHeldError)) {
        deps.log(`could not reclaim ${name}: ${failure.message}`);
      }
      failed.push({ tenant, error: failure.message });
    }
  }
  return { closed, failed };
}

/** Written to a temporary name, then linked into place: never half-written, never overwritten. */
function writeGrant(deps, tenant, state) {
  fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  const unique = crypto.randomBytes(6).toString('hex');
  const temporary = path.join(deps.stateDir, `.${tenant}.${process.pid}.${unique}.tmp`);
  // 'wx' refuses to follow or reuse anything already at that name.
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temporary, statePath(deps, tenant));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function stateNames(deps) {
  try {
    return fs.readdirSync(deps.stateDir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function record(deps, entry) {
  fs.appendFileSync(deps.recordLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Opens a grant on the tenant's configured support account. The clock is
 * written before the door opens, so a grant that fails half-way is still
 * closed at its deadline.
 */
export async function grant({ lane, tenant, identity, reason, reference }, deps = defaultDeps()) {
  if (!deps.timerActive()) {
    throw new GrantRefusedError(
      `${EXPIRE_TIMER_UNIT} is not active, so nothing would close this grant`
    );
  }
  let existing;
  try {
    existing = readGrant(deps, tenant);
  } catch (error) {
    throw new GrantRefusedError(`${error.message}; close it with revoke first`);
  }
  if (existing) {
    throw new GrantRefusedError(`a grant for ${tenant} is already open until ${existing.deadline}`);
  }
  // After the state check, so a close that claimed the state in between is seen here.
  const [held] = claimsFor(deps, tenant);
  if (held) {
    throw new GrantRefusedError(
      `a grant for ${tenant} is held in ${held}; close it with revoke first`
    );
  }
  const container = await deps.findContainer(tenant);
  // Read-only: the identity comes from the tenant's config; a typed one must match it.
  const configured = (await deps.run({ container, action: 'identity', expect: identity })).identity;
  const grantedAtMs = deps.now();
  const state = {
    grantId: crypto.randomUUID(),
    tenant,
    identity: configured,
    lane,
    reason,
    reference,
    grantedAt: iso(grantedAtMs),
    deadline: iso(grantedAtMs + GRANT_WINDOW_SECONDS * 1000),
  };
  writeGrant(deps, tenant, state);
  const written = stateFingerprint(deps, tenant);
  let result;
  let recreated = false;
  try {
    if (lane === 'consented') {
      result = await deps.run({ container, action: 'check', expect: configured });
    } else {
      result = await deps.run({ container, action: 'activate', expect: configured });
      if (result.absent) {
        // The anti-lockout guarantee: the provisioning script recreates the
        // deleted account suspended, then it is activated like any other.
        recreated = (await deps.recreate({ container, identity: configured })).created === true;
        result = await deps.run({ container, action: 'activate', expect: configured });
        if (result.absent) throw new Error('the support account could not be recreated');
      }
    }
  } catch (error) {
    if (lane === 'consented') {
      // Nothing was written to the tenant's database: there is nothing to close.
      try {
        removeStateIfSame(deps, tenant, written);
      } catch (cleanup) {
        // The failure being reported is the check's. A held state was already logged.
        if (!(cleanup instanceof StateHeldError)) {
          deps.log(`could not clear the grant state for ${tenant}: ${cleanup.message}`);
        }
      }
    }
    throw error;
  }
  record(deps, { event: 'opened', ...state, recreated, previousStatus: result.previousStatus });
  return { ...state, recreated, previousStatus: result.previousStatus };
}

/**
 * Closes the tenant's configured support account: suspend and purge, wait,
 * suspend and purge again, then the closing record. Needs no state file, and
 * runs whatever the account's status: a session made while active survives a
 * re-suspend and wakes on the next un-suspend.
 */
export async function revoke({ tenant, reason, cause = 'explicit' }, deps = defaultDeps()) {
  let open = null;
  let stateUnreadable = null;
  const seen = stateFingerprint(deps, tenant);
  // Claims held now are covered by this close; one made later may be a newer grant.
  const held = claimsFor(deps, tenant);
  try {
    open = readGrant(deps, tenant);
  } catch (error) {
    stateUnreadable = error.message;
  }
  const heldGrant = open === null ? held.map((name) => readClaim(deps, name)).find(Boolean) : null;
  const container = await deps.findContainer(tenant);
  const first = await deps.run({ container, action: 'revoke' });
  await deps.betweenPurges();
  await deps.sleep(SECOND_PURGE_DELAY_MS);
  const second = await deps.run({ container, action: 'revoke' });
  const closing = {
    event: 'closed',
    ...(open ?? heldGrant ?? {}),
    tenant,
    identity: first.identity,
    cause,
    closeReason: reason,
    closedAt: iso(deps.now()),
    stateFound: open !== null,
    heldClaims: held.length,
    stateUnreadable,
    identityChanged: (open ?? heldGrant) != null && (open ?? heldGrant).identity !== first.identity,
    accountFound: first.found || second.found,
    previousStatus: first.previousStatus ?? null,
    sessionsPurged: [first.sessionsPurged, second.sessionsPurged],
  };
  record(deps, closing);
  for (const name of held) fs.rmSync(path.join(deps.stateDir, name), { force: true });
  removeStateIfSame(deps, tenant, seen);
  return closing;
}

/**
 * What the timer runs. Each grant is handled on its own: one that cannot be
 * read is closed rather than skipped, and one failure never stops the rest.
 */
export async function expire(deps = defaultDeps()) {
  const { closed, failed } = await reclaimClaims(deps);
  for (const name of stateNames(deps)) {
    const tenant = name.slice(0, -'.json'.length);
    try {
      if (!TENANT.test(tenant)) throw new Error(`${name} does not name a tenant`);
      let open = null;
      try {
        open = readGrant(deps, tenant);
        if (open === null) continue; // closed by a revoke since the listing
      } catch (error) {
        deps.log(`${error.message}; closing it now`);
      }
      if (open && Date.parse(open.deadline) > deps.now()) continue;
      closed.push(await revoke({ tenant, reason: 'four-hour window ended', cause: 'timer' }, deps));
    } catch (error) {
      // The state file stays, so the next run retries.
      deps.log(`could not close ${tenant}: ${error.message}`);
      failed.push({ tenant, error: error.message });
    }
  }
  return { closed, failed };
}

export function status(deps = defaultDeps()) {
  const open = stateNames(deps).map((name) => {
    const tenant = name.slice(0, -'.json'.length);
    try {
      return readGrant(deps, tenant);
    } catch (error) {
      return { tenant, unreadable: error.message };
    }
  });
  // A held claim is a grant whose state could not be put back; expire restores it.
  const held = claimNames(deps).map((name) => ({
    ...(readClaim(deps, name) ?? {}),
    tenant: CLAIM_NAME.exec(name)[1],
    held: name,
  }));
  return [...open, ...held];
}

export async function main(argv, deps = defaultDeps(), stdout = process.stdout) {
  const args = parseGrantArgs(argv);
  let result;
  if (args.command === 'grant') result = await grant(args, deps);
  else if (args.command === 'revoke') result = await revoke(args, deps);
  else if (args.command === 'status') result = status(deps);
  else result = await expire(deps);
  stdout.write(`${JSON.stringify(result)}\n`);
  return args.command === 'expire' && result.failed.length > 0 ? 1 : 0;
}

/**
 * The process is PID 1 in its container, and PID 1 ignores a signal it has no
 * handler for. Without this, systemd's stop and a Ctrl-C would be ignored.
 */
export function exitOnTermination(proc = process) {
  proc.on('SIGTERM', () => proc.exit(143));
  proc.on('SIGINT', () => proc.exit(130));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  exitOnTermination();
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`break-glass-grant: ${error.message}\n`);
      process.exitCode = error instanceof GrantRefusedError ? 2 : 1;
    }
  );
}
