#!/usr/bin/env node
// Ask the control plane whether a tenant name is taken. See tenant-name-lookup.md.
//
// Exit 0: free. Exit 1: taken. Exit 2: anything else (fail closed).
// No flags, no file input, no write path, never a list. The token and the
// response body are never printed.
import { pathToFileURL } from 'node:url';

export const EXIT_FREE = 0;
export const EXIT_TAKEN = 1;
export const EXIT_REFUSED = 2;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 1024;

// Not the slug rule (the workflow's own regex runs first in the same step). This
// only keeps a value that reaches a URL path from being able to change the path.
const PATH_SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A lookup that could not be completed. Its message is safe to print. */
export class LookupRefused extends Error {}

function lookupUrl(baseUrl, name) {
  if (typeof name !== 'string' || !PATH_SAFE_NAME.test(name)) {
    throw new LookupRefused('the tenant name is not a valid lookup key');
  }
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new LookupRefused('CONTROL_PLANE_NAME_LOOKUP_URL is not a URL');
  }
  const loopback = base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== 'https:' && !loopback) {
    throw new LookupRefused('CONTROL_PLANE_NAME_LOOKUP_URL must be https');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new LookupRefused(
      'CONTROL_PLANE_NAME_LOOKUP_URL must be an origin and path only, with no credentials, query or fragment'
    );
  }
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/tenant-names/${name}`;
}

/**
 * Whether the control plane says `name` is taken. Resolves true or false only
 * for HTTP 200 with a JSON object whose `taken` is a boolean; anything else
 * throws LookupRefused.
 */
export async function isNameTaken({
  name,
  baseUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!token) {
    throw new LookupRefused('CONTROL_PLANE_NAME_LOOKUP_TOKEN is empty or unset');
  }
  const url = lookupUrl(baseUrl, name);
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      // A redirect would carry the bearer token to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      throw new LookupRefused(`the control plane answered HTTP ${response.status}`);
    }
    text = await response.text();
  } catch (error) {
    if (error instanceof LookupRefused) throw error;
    throw new LookupRefused('the control plane could not be reached, or did not answer in time');
  }
  if (text.length > MAX_BODY_CHARS) {
    throw new LookupRefused('the control plane answer was not the documented shape');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LookupRefused('the control plane answer was not the documented shape');
  }
  if (body === null || typeof body !== 'object' || typeof body.taken !== 'boolean') {
    throw new LookupRefused('the control plane answer was not the documented shape');
  }
  return body.taken;
}

/** The CLI body, with its inputs injected so tests need no process. */
export async function run({ env, argv = [], fetchImpl, timeoutMs, stdout, stderr }) {
  if (argv.length > 0) {
    stderr.write(
      '::error::tenant-name-lookup takes no arguments; it reads TENANT from the environment\n'
    );
    return EXIT_REFUSED;
  }
  try {
    const taken = await isNameTaken({
      name: env.TENANT,
      baseUrl: env.CONTROL_PLANE_NAME_LOOKUP_URL,
      token: env.CONTROL_PLANE_NAME_LOOKUP_TOKEN,
      fetchImpl,
      timeoutMs,
    });
    if (taken) {
      stderr.write(
        '::error::tenant_name is already taken: the control plane reports that name as in use.\n'
      );
      return EXIT_TAKEN;
    }
    stdout.write('tenant name is free according to the control plane\n');
    return EXIT_FREE;
  } catch (error) {
    // Any other failure is also a refusal, never an uncaught throw: Node exits
    // an uncaught error with 1, which this CLI reserves for "taken".
    const reason = error instanceof LookupRefused ? error.message : 'unexpected internal error';
    stderr.write(
      `::error::tenant name lookup refused (fail closed): ${reason}. Nothing has been created.\n`
    );
    return EXIT_REFUSED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run({
    env: process.env,
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
