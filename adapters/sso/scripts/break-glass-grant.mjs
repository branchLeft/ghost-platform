#!/usr/bin/env node
// The two grant lanes and the four-hour clock, run as root on the tenant's
// own host. A person runs grant and revoke over SSH; a systemd timer runs
// expire every minute. See break-glass-grant.md for the lanes, the clock,
// the double purge and the records this writes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ActiveExistingRowError, provisionSupportAccount } from './provision-support-account.mjs';

export const GRANT_STATE_DIRECTORY = '/var/lib/branchleft/break-glass-grants';
export const GRANT_RECORD_LOG = '/var/log/branchleft/break-glass-grants.jsonl';
export const EXPIRE_TIMER_UNIT = 'branchleft-break-glass-expire.timer';
/** Owner ruling D13: four hours. Incidental, so a constant, never a flag. */
export const GRANT_WINDOW_SECONDS = 4 * 60 * 60;
/** Requirement 1 of the adapter review: purge, wait a few seconds, purge again. */
export const SECOND_PURGE_DELAY_MS = 5000;
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
  const needs = {
    grant: ['lane', 'tenant', 'identity', 'reason', 'reference'],
    revoke: ['tenant', 'reason'],
    expire: [],
    status: [],
  }[command];
  if (!needs) {
    throw new GrantRefusedError('the command must be grant, revoke, expire or status');
  }
  const extra = Object.keys(flags).filter((name) => !needs.includes(name));
  if (extra.length > 0) {
    throw new GrantRefusedError(`${command} does not take --${extra.join(', --')}`);
  }
  for (const name of needs) {
    if (flags[name] === undefined) throw new GrantRefusedError(`${command} needs --${name}`);
  }
  if (flags.lane !== undefined && !LANES.includes(flags.lane)) {
    throw new GrantRefusedError(`--lane must be one of ${LANES.join(', ')}`);
  }
  if (flags.tenant !== undefined && !TENANT.test(flags.tenant)) {
    throw new GrantRefusedError('--tenant must be the tenant slug');
  }
  if (flags.identity !== undefined && !IDENTITY.test(flags.identity)) {
    throw new GrantRefusedError('--identity must be the support account email');
  }
  for (const name of ['reason', 'reference']) {
    if (flags[name] !== undefined && !ONE_LINE.test(flags[name])) {
      throw new GrantRefusedError(`--${name} must be one printable line of 1-200 characters`);
    }
  }
  return { command, ...flags };
}

/**
 * Runs inside the tenant's running Ghost container through Ghost's own knex,
 * as provision-support-account.mjs does. Values arrive as env vars, never as
 * script text. ACTION is activate, check or revoke.
 */
export const INNER_SCRIPT = `
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
  const email = process.env.BL_IDENTITY;
  const action = process.env.BL_ACTION;
  try {
    const result = await knex.transaction(async (trx) => {
      const a = await account(trx, email);
      if (action === 'check') {
        if (!a) refuse('the support account does not exist; the tenant deleted it');
        if (!onlyAdministrator(a)) refuse('the account is not the support Administrator');
        if (!ACTIVE.includes(a.status)) refuse('the tenant has not un-suspended the support account (status ' + a.status + ')');
        return { id: a.id, previousStatus: a.status };
      }
      if (action === 'activate') {
        if (!a) refuse('the support account does not exist');
        if (!onlyAdministrator(a)) refuse('the account is not the support Administrator');
        await trx('users').where('id', a.id).update({ status: 'active' });
        return { id: a.id, previousStatus: a.status };
      }
      if (action === 'revoke') {
        if (!a) return { found: false, sessionsPurged: 0 };
        if (a.roles.includes('Owner')) refuse('the account holds the Owner role; it is never suspended');
        await trx('users').where('id', a.id).update({ status: 'inactive' });
        const purged = await trx('sessions').where('user_id', a.id).del();
        return { found: true, id: a.id, previousStatus: a.status, sessionsPurged: purged };
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
export function findTenantContainer(tenant, execFile = execFileSync) {
  const out = execFile(
    'docker',
    [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${tenant}`,
      '--filter',
      'status=running',
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.service"}}',
    ],
    { encoding: 'utf8' }
  );
  const names = out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([, service]) => GHOST_SERVICES.includes(service))
    .map(([name]) => name)
    .sort();
  if (names.length === 0) {
    throw new GrantRefusedError(`no running Ghost container for tenant ${tenant}`);
  }
  return names[0];
}

/** Runs one ACTION in the container and returns its JSON result. */
export function runInContainer({ container, identity, action }, execFile = execFileSync) {
  const args = ['exec', '-e', `BL_IDENTITY=${identity}`, '-e', `BL_ACTION=${action}`, container];
  let output;
  try {
    output = execFile('docker', [...args, 'node', '-e', INNER_SCRIPT], { encoding: 'utf8' });
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const at = stderr.indexOf(REFUSAL_MARKER);
    if (at !== -1) {
      throw new GrantRefusedError(
        stderr
          .slice(at + REFUSAL_MARKER.length)
          .split('\n')[0]
          .trim()
      );
    }
    throw new Error(
      `docker exec ${action} failed: ${stderr.trim().slice(0, 600) || error.message}`
    );
  }
  const line = output
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`docker exec ${action} printed no result`);
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

function systemctlIsActive(unit, execFile = execFileSync) {
  try {
    execFile('systemctl', ['is-active', '--quiet', unit], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Production wiring. Tests replace any of these. */
export function defaultDeps() {
  return {
    stateDir: GRANT_STATE_DIRECTORY,
    recordLog: GRANT_RECORD_LOG,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timerActive: () => systemctlIsActive(EXPIRE_TIMER_UNIT),
    findContainer: (tenant) => findTenantContainer(tenant),
    run: (request) => runInContainer(request),
    recreate: ({ container, identity }) => recreateIfDeleted({ container, identity }),
    betweenPurges: async () => {},
  };
}

/**
 * Provisions the account when the tenant deleted it. An account the tenant
 * already un-suspended is present, so it is not an error here.
 */
export function recreateIfDeleted({ container, identity }, provision = provisionSupportAccount) {
  try {
    return provision({ container, email: identity });
  } catch (error) {
    if (error instanceof ActiveExistingRowError) return { created: false };
    throw error;
  }
}

const statePath = (deps, tenant) => path.join(deps.stateDir, `${tenant}.json`);

function readGrant(deps, tenant) {
  try {
    return JSON.parse(fs.readFileSync(statePath(deps, tenant), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function record(deps, entry) {
  fs.appendFileSync(deps.recordLog, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Opens a grant. The clock is written before the door opens: the state file
 * the expire timer reads exists before the account is touched, so a grant
 * that fails half-way is still closed at its deadline.
 */
export async function grant({ lane, tenant, identity, reason, reference }, deps = defaultDeps()) {
  if (!deps.timerActive()) {
    throw new GrantRefusedError(
      `${EXPIRE_TIMER_UNIT} is not active, so nothing would close this grant`
    );
  }
  const existing = readGrant(deps, tenant);
  if (existing) {
    throw new GrantRefusedError(`a grant for ${tenant} is already open until ${existing.deadline}`);
  }
  const container = deps.findContainer(tenant);
  const grantedAtMs = deps.now();
  const state = {
    tenant,
    identity,
    lane,
    reason,
    reference,
    grantedAt: iso(grantedAtMs),
    deadline: iso(grantedAtMs + GRANT_WINDOW_SECONDS * 1000),
  };
  fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath(deps, tenant), `${JSON.stringify(state)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  let result;
  let recreated = false;
  try {
    if (lane === 'consented') {
      result = deps.run({ container, identity, action: 'check' });
    } else {
      // The anti-lockout guarantee: a deleted account is recreated, suspended,
      // by the provisioning script, then activated like any other.
      const created = deps.recreate({ container, identity });
      recreated = created.created === true;
      result = deps.run({ container, identity, action: 'activate' });
    }
  } catch (error) {
    if (lane === 'consented') {
      // Nothing was written to the tenant's database: there is nothing to close.
      fs.rmSync(statePath(deps, tenant), { force: true });
    }
    throw error;
  }
  record(deps, { event: 'opened', ...state, recreated, previousStatus: result.previousStatus });
  return { ...state, recreated, previousStatus: result.previousStatus };
}

/**
 * Closes a grant: suspend and purge, wait, suspend and purge again, then the
 * closing record. Runs whatever the account's status, because a session made
 * while active survives a re-suspend and wakes on the next un-suspend.
 */
export async function revoke({ tenant, reason, cause = 'explicit' }, deps = defaultDeps()) {
  const open = readGrant(deps, tenant);
  if (!open) {
    throw new GrantRefusedError(`no grant is open for ${tenant}`);
  }
  const container = deps.findContainer(tenant);
  const first = deps.run({ container, identity: open.identity, action: 'revoke' });
  await deps.betweenPurges();
  await deps.sleep(SECOND_PURGE_DELAY_MS);
  const second = deps.run({ container, identity: open.identity, action: 'revoke' });
  const closing = {
    event: 'closed',
    ...open,
    cause,
    closeReason: reason,
    closedAt: iso(deps.now()),
    accountFound: first.found || second.found,
    previousStatus: first.previousStatus ?? null,
    sessionsPurged: [first.sessionsPurged, second.sessionsPurged],
  };
  record(deps, closing);
  fs.rmSync(statePath(deps, tenant), { force: true });
  return closing;
}

/** What the timer runs: closes every grant past its deadline. */
export async function expire(deps = defaultDeps()) {
  let names = [];
  try {
    names = fs.readdirSync(deps.stateDir).filter((n) => n.endsWith('.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const closed = [];
  const failed = [];
  for (const name of names) {
    const tenant = name.slice(0, -'.json'.length);
    const open = readGrant(deps, tenant);
    if (!open || Date.parse(open.deadline) > deps.now()) continue;
    try {
      closed.push(await revoke({ tenant, reason: 'four-hour window ended', cause: 'timer' }, deps));
    } catch (error) {
      // The state file stays, so the next run retries.
      failed.push({ tenant, error: error.message });
    }
  }
  return { closed, failed };
}

export function status(deps = defaultDeps()) {
  let names = [];
  try {
    names = fs.readdirSync(deps.stateDir).filter((n) => n.endsWith('.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return names.map((n) => readGrant(deps, n.slice(0, -'.json'.length))).filter(Boolean);
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
