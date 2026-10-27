import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds, once per run, the patched session-from-token.js the unit tests use.
// Baseline sources and the fail-loudly rule: see
// adapters/sso/ghost-core-overlay/README.md.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SSO_DIR = path.resolve(__dirname, '../..');
const OVERLAY_DIR = path.join(SSO_DIR, 'ghost-core-overlay');
const DERIVED_DIR = path.join(OVERLAY_DIR, 'derived');
const BASELINE_DIR = path.join(DERIVED_DIR, 'baseline');
const DOCKERFILE = path.resolve(SSO_DIR, '../../Dockerfile');
const GHOST_FILE = '/var/lib/ghost/current/core/server/services/auth/session/session-from-token.js';

function pinnedImage() {
  const froms = fs
    .readFileSync(DOCKERFILE, 'utf8')
    .split('\n')
    .filter((line) => /^FROM\s/i.test(line));
  if (froms.length !== 1) {
    throw new Error(`expected exactly one FROM line in ${DOCKERFILE}, found ${froms.length}`);
  }
  return froms[0].split(/\s+/)[1];
}

function extractBaselineFromImage(dest) {
  const cid = execFileSync('docker', ['create', pinnedImage()], { encoding: 'utf8' }).trim();
  try {
    execFileSync('docker', ['cp', `${cid}:${GHOST_FILE}`, dest]);
  } finally {
    execFileSync('docker', ['rm', '-f', '-v', cid], { stdio: 'ignore' });
  }
}

export default function setup() {
  fs.rmSync(DERIVED_DIR, { recursive: true, force: true });
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const baseline = path.join(BASELINE_DIR, 'session-from-token.js');

  const given = process.env.GHOST_SESSION_FROM_TOKEN_BASELINE;
  if (given) {
    fs.copyFileSync(given, baseline);
  } else {
    extractBaselineFromImage(baseline);
  }

  // Apply on a copy so the pristine baseline stays available to the tests that
  // check the build gate against a changed upstream.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sso-overlay-derive-'));
  try {
    fs.copyFileSync(baseline, path.join(work, 'session-from-token.js'));
    execFileSync(path.join(OVERLAY_DIR, 'apply-session-from-token-patch.sh'), [work], {
      stdio: 'inherit',
    });
    fs.copyFileSync(
      path.join(work, 'session-from-token.js'),
      path.join(DERIVED_DIR, 'session-from-token.js')
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
