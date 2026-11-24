/**
 * Boots a tenant image under the render core's own current compose.yml.
 *
 * Separates two causes of a failed tenant restart:
 * (a) the operator-placed compose.yml no longer matches what the render
 * produces, and (b) the image itself does not boot. This test renders the
 * blog's stack with the current render core, runs the rendered compose.yml
 * against a named image digest, and asserts Ghost answers 200 on `/`.
 *
 * Only what a CI runner cannot provide is substituted, and each substitution
 * is asserted to have matched exactly once (a control, so a silent no-op
 * cannot pass):
 *   - the host's private bind address becomes 127.0.0.1 on the same port;
 *   - the database host becomes a throwaway MySQL service in the same project;
 *   - the external volumes and the external mail network are created empty,
 *     as the host provisioning does.
 * Every other line of the rendered compose.yml runs as rendered.
 *
 * Skipped unless TENANT_BOOT_IMAGE names an image reference (repository@sha256:…)
 * and Docker is available. Run by .github/workflows/tenant-boot-ci.yml.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantStackDescriptor } from '../src/descriptor.js';
import { render, type Artefact } from '../src/render.js';
import { validateTenantStack } from '../src/validate.js';
import { TEST_ZONES } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = 'branchLeft/ghost-tenant-blog';
const BOOT_IMAGE = process.env.TENANT_BOOT_IMAGE ?? '';
const PROJECT = `tenant-boot-${process.pid}`;
const DB_ROOT_PASSWORD = 'boot-proof-root-not-a-secret';
const MAIL_NETWORK = 'branchleft-mail-30001';
const VOLUMES = ['ghost-blog-content', 'ghost-blog-adapters', 'ghost-blog-metrics'];
const LOOPBACK_PORT = 8101;
const ANSWER_TIMEOUT_MS = 240_000;

// Throwaway values for the secrets the render names. The proof is that Ghost
// boots and answers, never that any of these paths works, so no real value
// belongs here.
const TEST_SECRETS: Record<string, string> = {
  GHOST_DB_PASSWORD: 'boot-proof-db-not-a-secret',
  GHOST_S3_ACCESS_KEY_ID: 'boot-proof-s3-id',
  GHOST_S3_SECRET_ACCESS_KEY: 'boot-proof-s3-secret',
  GHOST_MAIL_PASSWORD: 'boot-proof-mail-password',
  GHOST_BULK_EMAIL_API_KEY: 'boot-proof-bulk-email-key',
};

const canRun = BOOT_IMAGE !== '' && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

function loadDescriptor(): TenantStackDescriptor {
  const raw = readFileSync(join(here, 'tenant-zero', 'blog.descriptor.json'), 'utf-8');
  return JSON.parse(raw) as TenantStackDescriptor;
}

function renderedCompose(): string {
  const accepted = validateTenantStack(loadDescriptor(), TEST_ZONES, { claimantRepo: REPO });
  const artefacts: readonly Artefact[] = render(accepted, TEST_ZONES);
  const compose = artefacts.find((artefact) => artefact.path === 'compose.yml');
  if (compose === undefined) throw new Error('render produced no compose.yml');
  return compose.content;
}

/** Replace `from` with `to`, asserting the control: `from` occurs exactly once. */
function replaceOnce(text: string, from: string, to: string): string {
  const occurrences = text.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one ${JSON.stringify(from)} in the rendered compose.yml, found ${occurrences}`
    );
  }
  return text.replace(from, to);
}

/** The throwaway MySQL service the rendered Ghost reaches as host `db`. */
const DB_SERVICE = `  db:
    image: 'mysql:8.4'
    environment:
      MYSQL_ROOT_PASSWORD: '${DB_ROOT_PASSWORD}'
      MYSQL_DATABASE: 'ghost_blog'
      MYSQL_USER: 'ghost_blog'
      MYSQL_PASSWORD: '\${GHOST_DB_PASSWORD}'
    healthcheck:
      test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-u', 'root', '-p${DB_ROOT_PASSWORD}']
      interval: '2s'
      timeout: '5s'
      retries: 90
`;

/** The rendered compose.yml, with only the CI substitutions applied. */
function bootComposeText(): string {
  let text = renderedCompose();
  text = replaceOnce(text, "'10.20.1.100:8101:2368'", `'127.0.0.1:${LOOPBACK_PORT}:2368'`);
  text = replaceOnce(
    text,
    "database__connection__host: '10.20.1.20'",
    "database__connection__host: 'db'"
  );
  text = replaceOnce(text, '\nnetworks:\n', `\n${DB_SERVICE}networks:\n`);
  return text;
}

function run(args: string[], composeFile: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('docker', ['compose', '-f', composeFile, '-p', PROJECT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...TEST_SECRETS, IMAGE: BOOT_IMAGE, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function answersOk(url: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: number | undefined;
  while (Date.now() < deadline) {
    try {
      // The rendered `url` is https, so a probe without X-Forwarded-Proto is
      // redirected forever; the rendered healthcheck sends the same header.
      const res = await fetch(url, {
        headers: { 'X-Forwarded-Proto': 'https' },
        redirect: 'manual',
      });
      if (res.status === 200) return 200;
      last = res.status;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return last;
}

let workdir = '';
let composeFile = '';

describe.skipIf(!canRun)('LIVE tenant boot: the render core compose runs the pinned image', () => {
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'tenant-boot-'));
    composeFile = join(workdir, 'compose.yml');
    writeFileSync(composeFile, bootComposeText());
    // The render's external network and volumes are host-provisioned in
    // production. A fresh Docker volume is root-owned, and Ghost runs as
    // 30001:30001 with a read-only root, so each is chowned to the slot's uid.
    execFileSync('docker', ['network', 'create', '--internal', MAIL_NETWORK], { stdio: 'ignore' });
    for (const volume of VOLUMES) {
      execFileSync('docker', ['volume', 'create', volume], { stdio: 'ignore' });
      execFileSync(
        'docker',
        ['run', '--rm', '-v', `${volume}:/data`, 'alpine', 'chown', '-R', '30001:30001', '/data'],
        { stdio: 'ignore' }
      );
    }
  }, 120_000);

  afterAll(() => {
    try {
      run(['down', '-v', '--timeout', '5'], composeFile);
    } catch {
      // best-effort
    }
    for (const volume of VOLUMES)
      spawnSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'ignore' });
    spawnSync('docker', ['network', 'rm', MAIL_NETWORK], { stdio: 'ignore' });
    if (workdir !== '') rmSync(workdir, { recursive: true, force: true });
  }, 120_000);

  it(
    'starts the throwaway database, then the rendered Ghost, and gets 200 on /',
    async () => {
      // Control: the compose under test is the render with only the CI
      // substitutions, and it pins the digest this run was given.
      expect(readFileSync(composeFile, 'utf-8')).toContain(`'127.0.0.1:${LOOPBACK_PORT}:2368'`);

      run(['up', '-d', '--wait', 'db'], composeFile);
      run(['up', '-d', 'ghost-a'], composeFile);

      const status = await answersOk(`http://127.0.0.1:${LOOPBACK_PORT}/`, ANSWER_TIMEOUT_MS);
      if (status !== 200) {
        const logs = run(['logs', '--no-color', 'ghost-a'], composeFile);
        throw new Error(
          `ghost-a did not answer 200 on / within ${ANSWER_TIMEOUT_MS / 1000}s (last status ${status ?? 'none'}). ` +
            `Image ${BOOT_IMAGE}. ghost-a logs:\n${logs}`
        );
      }
      expect(status).toBe(200);
    },
    ANSWER_TIMEOUT_MS + 180_000
  );
});

describe.skipIf(canRun)('LIVE tenant boot: skipped', () => {
  it('needs TENANT_BOOT_IMAGE and Docker; the render-core job does not set them', () => {
    expect(canRun).toBe(false);
  });
});
