#!/usr/bin/env node
// Creates a fresh tenant Ghost's owner account from the app host, so the
// public setup page is never the way in, and emails the owner a sign-in
// link. See provision-owner.md for the usage, the flow and the guarantees.

import { execFileSync } from 'node:child_process';

/** The only address Ghost listens on inside its own container. */
const GHOST_LISTEN = '127.0.0.1:2368';

/** Marks a refusal from the inner script's stderr, which cannot cross the docker exec boundary as a class. */
const REFUSED_MARKER = 'OWNER_PROVISION_REFUSED: ';

/** Ghost already has an owner, or the setup route did not accept the request. */
export class OwnerProvisionRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwnerProvisionRefusedError';
  }
}

export function parseArgs(argv) {
  const known = {
    '--container': 'container',
    '--email': 'email',
    '--name': 'name',
    '--site-url': 'siteUrl',
    '--site-title': 'siteTitle',
  };
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = known[argv[i]];
    if (!key) throw new Error(`unrecognised argument: ${argv[i]}`);
    args[key] = argv[i + 1];
    i += 1;
  }
  for (const [flag, key] of Object.entries(known)) {
    if (!args[key]) throw new Error(`${flag} is required`);
  }
  let url;
  try {
    url = new URL(args.siteUrl);
  } catch {
    throw new Error('--site-url must be an absolute URL');
  }
  if (url.protocol !== 'https:') throw new Error('--site-url must be an https URL');
  if (!/^[^\s@]+@[^\s@]+$/.test(args.email)) throw new Error('--email must be an email address');
  return args;
}

/**
 * Runs inside the tenant's own container. The owner's password is generated
 * here, handed to Ghost and dropped: it is never printed, logged or passed
 * through argv or env, so nothing outside this process ever holds it. The
 * owner gets a reset link by email and chooses their own.
 */
const INNER_SCRIPT = `
const http = require('node:http');
const crypto = require('node:crypto');
const [host, port] = '${GHOST_LISTEN}'.split(':');
const site = new URL(process.env.PROVISION_OWNER_SITE_URL);
const headers = {
  'content-type': 'application/json',
  host: site.host,
  origin: site.origin,
  'x-forwarded-proto': 'https',
};
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function refuse(reason) {
  console.error('${REFUSED_MARKER}' + reason);
  process.exit(3);
}
async function main() {
  const state = await call('GET', '/ghost/api/admin/authentication/setup/');
  if (state.status !== 200) refuse('setup status answered ' + state.status + ' ' + state.text.slice(0, 300));
  if (JSON.parse(state.text).setup[0].status === true) {
    console.log(JSON.stringify({ created: false, alreadySetUp: true }));
    return;
  }
  const created = await call('POST', '/ghost/api/admin/authentication/setup/', {
    setup: [{
      name: process.env.PROVISION_OWNER_NAME,
      email: process.env.PROVISION_OWNER_EMAIL,
      password: crypto.randomBytes(32).toString('base64url'),
      blogTitle: process.env.PROVISION_OWNER_SITE_TITLE,
    }],
  });
  if (created.status !== 201) refuse('setup answered ' + created.status + ' ' + created.text.slice(0, 300));
  const link = await call('POST', '/ghost/api/admin/authentication/password_reset/', {
    password_reset: [{ email: process.env.PROVISION_OWNER_EMAIL }],
  });
  if (link.status !== 200) refuse('the owner exists but the sign-in link request answered ' + link.status + ' ' + link.text.slice(0, 300));
  console.log(JSON.stringify({ created: true, alreadySetUp: false, linkRequested: true }));
}
main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
`;

/**
 * Creates the owner through Ghost's own setup route from inside `container`
 * and asks Ghost to email them a sign-in link. A Ghost that already has an
 * owner is left untouched and reported as `alreadySetUp`. Throws
 * `OwnerProvisionRefusedError` if Ghost refuses a step.
 */
export function provisionOwner(
  { container, email, name, siteUrl, siteTitle },
  execFile = execFileSync
) {
  const env = [
    `PROVISION_OWNER_EMAIL=${email}`,
    `PROVISION_OWNER_NAME=${name}`,
    `PROVISION_OWNER_SITE_URL=${siteUrl}`,
    `PROVISION_OWNER_SITE_TITLE=${siteTitle}`,
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
    const at = stderr.indexOf(REFUSED_MARKER);
    if (at !== -1) {
      throw new OwnerProvisionRefusedError(
        stderr
          .slice(at + REFUSED_MARKER.length)
          .split('\n')[0]
          .trim()
      );
    }
    throw error;
  }
  return JSON.parse(output.trim().split('\n').pop());
}

function main() {
  process.stdout.write(`${JSON.stringify(provisionOwner(parseArgs(process.argv.slice(2))))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
