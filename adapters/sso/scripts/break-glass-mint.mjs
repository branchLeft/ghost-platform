#!/usr/bin/env node
// Mints a break-glass token for one tenant, signed with the Ed25519 key in
// /etc/branchleft/break-glass/ on ops1. Owner-run only: no agent reads that
// directory. See break-glass-mint.md for the commands, the audit record and
// why each refusal exists.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The one key directory this tool reads. Never configurable from the CLI. */
export const KEY_DIRECTORY = '/etc/branchleft/break-glass';
export const KEY_FILE = path.join(KEY_DIRECTORY, 'signing-key.pem');
export const MINT_AUDIT_LOG = '/var/log/branchleft/break-glass-mint.jsonl';

/** The adapter caps at 900s from iat, with 60s of forward skew: 600 leaves margin. */
export const MINT_MAX_TTL_SECONDS = 600;
export const MINT_DEFAULT_TTL_SECONDS = 300;
const QUERY_PARAM = 'bl_break_glass';
// One printable line: it goes verbatim into the audit record.
const ONE_LINE = /^[\x21-\x7e][\x20-\x7e]{0,199}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IDENTITY = /^[^\s@]+@[^\s@]+$/;

export class MintRefusedError extends Error {
  constructor(message) {
    super(`refused: ${message}; nothing was minted`);
    this.name = 'MintRefusedError';
  }
}

export function parseMintArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!/^--(tenant|identity|reason|ttl|site)$/.test(name) || rest[i + 1] === undefined) {
      throw new MintRefusedError(`unrecognised or valueless argument: ${name}`);
    }
    flags[name.slice(2)] = rest[i + 1];
  }
  if (command === 'keygen' || command === 'public-key') {
    if (Object.keys(flags).length > 0) {
      throw new MintRefusedError(`${command} takes no arguments`);
    }
    return { command };
  }
  if (command !== 'mint') {
    throw new MintRefusedError('the command must be mint, keygen or public-key');
  }
  return { command, ...validateMintRequest(flags) };
}

/** Checks a mint request's values. Throws MintRefusedError on any of them. */
export function validateMintRequest({ tenant, identity, reason, ttl, site }) {
  if (typeof tenant !== 'string' || !TENANT.test(tenant)) {
    throw new MintRefusedError('--tenant must be the tenant slug');
  }
  if (typeof identity !== 'string' || !IDENTITY.test(identity)) {
    throw new MintRefusedError('--identity must be the support account email');
  }
  if (typeof reason !== 'string' || !ONE_LINE.test(reason)) {
    throw new MintRefusedError('--reason must be one printable line of 1-200 characters');
  }
  const ttlSeconds = ttl === undefined ? MINT_DEFAULT_TTL_SECONDS : Number(ttl);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MINT_MAX_TTL_SECONDS) {
    throw new MintRefusedError(
      `--ttl must be a whole number of seconds from 1 to ${MINT_MAX_TTL_SECONDS}`
    );
  }
  return {
    tenant,
    identity,
    reason,
    ttlSeconds,
    site: site === undefined ? null : siteOrigin(site),
  };
}

/** Accepts only a bare https origin, so the one URL built from it is /ghost/. */
export function siteOrigin(site) {
  let url;
  try {
    url = new URL(site);
  } catch {
    throw new MintRefusedError('--site must be an https origin such as https://example.com');
  }
  const bare = url.pathname === '/' && url.search === '' && url.hash === '';
  if (url.protocol !== 'https:' || !bare || url.username !== '' || url.password !== '') {
    throw new MintRefusedError('--site must be a bare https origin, with no path, query or login');
  }
  return url.origin;
}

/** The adapter is mounted on /ghost/ only: a token sent elsewhere is never consumed. */
export function breakGlassUrl(origin, token) {
  return `${origin}/ghost/?${QUERY_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Loads the private key. It is opened without following a symlink, and the
 * checks run on the opened file itself, so nothing can swap it in between.
 */
export function loadSigningKey(keyFile, fsImpl = fs) {
  let fd;
  try {
    // O_NONBLOCK: opening a FIFO here would otherwise wait for a writer, before the type check.
    fd = fsImpl.openSync(
      keyFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new MintRefusedError(`${keyFile} is a symlink; the key must be the file itself`);
    }
    throw new MintRefusedError(`no signing key at ${keyFile}`);
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw new MintRefusedError(
        `${keyFile} must be a regular file owned by this user and readable by its owner only (0600)`
      );
    }
    let key;
    try {
      key = crypto.createPrivateKey(fsImpl.readFileSync(fd));
    } catch {
      throw new MintRefusedError(`${keyFile} is not a readable private key`);
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new MintRefusedError(`${keyFile} is not an Ed25519 key`);
    }
    return key;
  } finally {
    fsImpl.closeSync(fd);
  }
}

/** The public half as the tenant's config carries it: base64 SPKI DER. */
export function publicKeyBase64(privateKey) {
  return crypto
    .createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
}

/** A short, non-secret name for the key, so the audit says which key signed. */
export function keyFingerprint(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** Signs the envelope adapters/sso/README.md "Token" describes. */
export function mintToken({ privateKey, tenant, identity, ttlSeconds, nowMs = Date.now() }) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MINT_MAX_TTL_SECONDS) {
    throw new MintRefusedError(`lifetime must be 1 to ${MINT_MAX_TTL_SECONDS} seconds`);
  }
  const iat = Math.floor(nowMs / 1000);
  const claims = {
    sub: identity,
    aud: tenant,
    iat,
    exp: iat + ttlSeconds,
    jti: crypto.randomBytes(16).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.sign(null, Buffer.from(body, 'ascii'), privateKey).toString('base64url');
  return { token: `${body}.${signature}`, claims };
}

/** One JSON line per mint. The token itself is never written. */
export function mintAuditRecord({ request, claims, fingerprint }) {
  return {
    event: 'minted',
    at: new Date(claims.iat * 1000).toISOString(),
    tenant: request.tenant,
    identity: request.identity,
    reason: request.reason,
    jti: claims.jti,
    iat: claims.iat,
    exp: claims.exp,
    key: fingerprint,
  };
}

/**
 * Mints and records. The audit line is written before the token is returned,
 * so a token never exists without its record.
 */
export function mint(
  request,
  { keyFile = KEY_FILE, auditLog = MINT_AUDIT_LOG, fsImpl = fs, nowMs } = {}
) {
  const privateKey = loadSigningKey(keyFile, fsImpl);
  const { token, claims } = mintToken({ privateKey, ...request, nowMs });
  const record = mintAuditRecord({ request, claims, fingerprint: keyFingerprint(privateKey) });
  try {
    fsImpl.appendFileSync(auditLog, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    throw new MintRefusedError(
      `the audit record could not be written to ${auditLog} (${error.code ?? error.message})`
    );
  }
  return { output: request.site ? breakGlassUrl(request.site, token) : token, claims };
}

/** Creates the key once. Refuses to overwrite: a lost key is rotated, never replaced in place. */
export function keygen({ keyFile = KEY_FILE, fsImpl = fs } = {}) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  try {
    fsImpl.writeFileSync(keyFile, pem, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new MintRefusedError(`${keyFile} already exists; keygen never overwrites a key`);
    }
    throw new MintRefusedError(`${keyFile} could not be written (${error.code ?? error.message})`);
  }
  return { publicKey: publicKeyBase64(privateKey), fingerprint: keyFingerprint(privateKey) };
}

export function main(argv, { stdout = process.stdout, ...deps } = {}) {
  const args = parseMintArgs(argv);
  if (args.command === 'keygen') {
    const { publicKey, fingerprint } = keygen(deps);
    stdout.write(`public key ${publicKey}\nfingerprint ${fingerprint}\n`);
    return;
  }
  if (args.command === 'public-key') {
    const key = loadSigningKey(deps.keyFile ?? KEY_FILE, deps.fsImpl);
    stdout.write(`public key ${publicKeyBase64(key)}\nfingerprint ${keyFingerprint(key)}\n`);
    return;
  }
  const { command: _command, ...request } = args;
  stdout.write(`${mint(request, deps).output}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`break-glass-mint: ${error.message}\n`);
    process.exitCode = error instanceof MintRefusedError ? 2 : 1;
  }
}
