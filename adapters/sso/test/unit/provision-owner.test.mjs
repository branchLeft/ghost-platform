import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OwnerProvisionRefusedError,
  parseArgs,
  parseOwnerEmail,
  provisionOwner,
} from '../../scripts/provision-owner.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/provision-owner.mjs', import.meta.url));
const OWNER_EMAIL = 'owner@example.invalid';

const GOOD = [
  '--container',
  'c1',
  '--secrets-file',
  '/etc/branchleft/tenant.env',
  '--name',
  'OWNER_NAME',
  '--site-url',
  'https://tenant.example.com',
  '--site-title',
  'SITE_TITLE',
];

describe('parseArgs', () => {
  it('parses every flag', () => {
    expect(parseArgs(GOOD)).toEqual({
      container: 'c1',
      secretsFile: '/etc/branchleft/tenant.env',
      name: 'OWNER_NAME',
      siteUrl: 'https://tenant.example.com',
      siteTitle: 'SITE_TITLE',
    });
  });

  it.each(['--container', '--secrets-file', '--name', '--site-url', '--site-title'])(
    'refuses a missing %s',
    (flag) => {
      const at = GOOD.indexOf(flag);
      const without = [...GOOD.slice(0, at), ...GOOD.slice(at + 2)];
      expect(() => parseArgs(without)).toThrow(flag);
    }
  );

  it('refuses an unrecognised flag -- never silently ignored', () => {
    expect(() => parseArgs([...GOOD, '--password', 'x'])).toThrow(/unrecognised argument/);
  });

  it('refuses --email: the address is never accepted on the command line', () => {
    expect(() => parseArgs([...GOOD, '--email', OWNER_EMAIL])).toThrow(
      'unrecognised argument: --email'
    );
  });

  it('has no way to supply a password', () => {
    expect(() => parseArgs([...GOOD, '--password', 'hunter2'])).toThrow(/unrecognised/);
  });

  it('refuses a site URL that is not absolute', () => {
    expect(() =>
      parseArgs(GOOD.map((v) => (v.startsWith('https://') ? 'tenant.example.com' : v)))
    ).toThrow(/absolute URL/);
  });

  it('refuses a plain-http site URL: a tenant is served over https only', () => {
    expect(() =>
      parseArgs(GOOD.map((v) => (v.startsWith('https://') ? 'http://tenant.example.com' : v)))
    ).toThrow(/https/);
  });
});

describe('parseOwnerEmail', () => {
  it('reads GHOST_OWNER_EMAIL from the secrets file beside other keys', () => {
    const text = `GHOST_DB_PASSWORD=unused\nGHOST_OWNER_EMAIL=${OWNER_EMAIL}\nOTHER=1\n`;
    expect(parseOwnerEmail(text)).toBe(OWNER_EMAIL);
  });

  it('tolerates CRLF line endings', () => {
    expect(parseOwnerEmail(`GHOST_OWNER_EMAIL=${OWNER_EMAIL}\r\n`)).toBe(OWNER_EMAIL);
  });

  it('does not match a key that merely ends in GHOST_OWNER_EMAIL', () => {
    expect(() => parseOwnerEmail(`XGHOST_OWNER_EMAIL=${OWNER_EMAIL}\n`)).toThrow(
      /GHOST_OWNER_EMAIL is not set/
    );
  });

  it('refuses a secrets file without the key', () => {
    expect(() => parseOwnerEmail('GHOST_DB_PASSWORD=unused\n')).toThrow(
      /GHOST_OWNER_EMAIL is not set/
    );
  });

  it('refuses an empty value', () => {
    expect(() => parseOwnerEmail('GHOST_OWNER_EMAIL=\n')).toThrow(/must be an email address/);
  });

  it('refuses a value that is not an address, without echoing it', () => {
    let message = '';
    try {
      parseOwnerEmail('GHOST_OWNER_EMAIL=not-an-address\n');
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/must be an email address/);
    expect(message).not.toContain('not-an-address');
  });

  it('refuses a quoted value: the quote marks would reach Ghost as part of the address', () => {
    expect(() => parseOwnerEmail(`GHOST_OWNER_EMAIL="${OWNER_EMAIL}"\n`)).toThrow(
      /must be an email address/
    );
  });
});

describe('provisionOwner', () => {
  const input = {
    container: 'my-container',
    email: OWNER_EMAIL,
    name: 'OWNER_NAME',
    siteUrl: 'https://tenant.example.com',
    siteTitle: 'SITE_TITLE',
  };

  it('runs one docker exec in the named container and parses the last output line', () => {
    const execFile = vi.fn(
      () => 'ghost log noise\n{"created":true,"alreadySetUp":false,"linkRequested":true}\n'
    );
    expect(provisionOwner(input, execFile)).toEqual({
      created: true,
      alreadySetUp: false,
      linkRequested: true,
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args] = execFile.mock.calls[0];
    expect(command).toBe('docker');
    expect(args[0]).toBe('exec');
    expect(args).toContain('my-container');
  });

  it('passes the owner on stdin, never in argv or in the script text', () => {
    const execFile = vi.fn(() => '{"created":false,"alreadySetUp":true}');
    provisionOwner({ ...input, email: "o'wner@example.invalid" }, execFile);
    const [, args, options] = execFile.mock.calls[0];
    expect(args.join('\n')).not.toContain('example.invalid');
    expect(args.join('\n')).not.toContain('OWNER_NAME');
    expect(args.join('\n')).not.toContain('SITE_TITLE');
    expect(JSON.parse(options.input)).toEqual({
      email: "o'wner@example.invalid",
      name: 'OWNER_NAME',
      siteUrl: 'https://tenant.example.com',
      siteTitle: 'SITE_TITLE',
    });
    const script = args.at(-1);
    expect(script).not.toContain('example.invalid');
    expect(script).not.toContain('OWNER_NAME');
  });

  it('never passes a password: the container generates one and drops it', () => {
    const execFile = vi.fn(() => '{"created":true,"alreadySetUp":false,"linkRequested":true}');
    provisionOwner(input, execFile);
    const args = execFile.mock.calls[0][1];
    expect(args.slice(0, -1).filter((a) => /password/i.test(a))).toEqual([]);
    const script = args.at(-1);
    expect(script).toContain('crypto.randomBytes(32)');
    expect(script).not.toMatch(/console\.(log|error)\([^)]*password/);
  });

  it('requests the link only after the owner is created, and only on a fresh Ghost', () => {
    const execFile = vi.fn(() => '{}');
    provisionOwner(input, execFile);
    const script = execFile.mock.calls[0][1].at(-1);
    const status = script.indexOf("'GET', '/ghost/api/admin/authentication/setup/'");
    const create = script.indexOf("'POST', '/ghost/api/admin/authentication/setup/'");
    const link = script.indexOf("'POST', '/ghost/api/admin/authentication/password_reset/'");
    const early = script.indexOf('alreadySetUp: true');
    expect(status).toBeGreaterThanOrEqual(0);
    expect(early).toBeGreaterThan(status);
    expect(create).toBeGreaterThan(early);
    expect(link).toBeGreaterThan(create);
  });

  it('compares an existing owner to the email before reporting a Ghost as set up', () => {
    const execFile = vi.fn(() => '{}');
    provisionOwner(input, execFile);
    const script = execFile.mock.calls[0][1].at(-1);
    const read = script.indexOf('await ownerEmail(');
    const refuse = script.indexOf('different owner', read);
    const report = script.indexOf('alreadySetUp: true', read);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(refuse).toBeGreaterThan(read);
    expect(report).toBeGreaterThan(refuse);
    expect(script).toContain('.toLowerCase()');
  });

  it('turns a refusal from inside the container into OwnerProvisionRefusedError', () => {
    const execFile = vi.fn(() => {
      const error = new Error('exit 3');
      error.stderr = 'noise\nOWNER_PROVISION_REFUSED: setup answered 403\n';
      throw error;
    });
    expect(() => provisionOwner(input, execFile)).toThrow(OwnerProvisionRefusedError);
    expect(() => provisionOwner(input, execFile)).toThrow('setup answered 403');
  });

  it('rethrows any other failure unchanged', () => {
    const boom = new Error('docker not found');
    const execFile = vi.fn(() => {
      throw boom;
    });
    expect(() => provisionOwner(input, execFile)).toThrow(boom);
  });
});

describe('the command line', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provision-owner-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the address from the secrets file and keeps it out of every docker argv', () => {
    const secrets = join(dir, 'tenant.env');
    writeFileSync(secrets, `GHOST_DB_PASSWORD=unused\nGHOST_OWNER_EMAIL=${OWNER_EMAIL}\n`);
    const argvLog = join(dir, 'argv.txt');
    const stdinLog = join(dir, 'stdin.txt');
    const fakeDocker = join(dir, 'docker');
    writeFileSync(
      fakeDocker,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\ncat > '${stdinLog}'\necho '{"created":false,"alreadySetUp":true}'\n`
    );
    chmodSync(fakeDocker, 0o755);

    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--container',
        'c1',
        '--secrets-file',
        secrets,
        '--name',
        'OWNER_NAME',
        '--site-url',
        'https://tenant.example.com',
        '--site-title',
        'SITE_TITLE',
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }
    );

    expect(JSON.parse(out)).toEqual({ created: false, alreadySetUp: true });
    expect(readFileSync(argvLog, 'utf8')).not.toContain(OWNER_EMAIL);
    expect(JSON.parse(readFileSync(stdinLog, 'utf8')).email).toBe(OWNER_EMAIL);
  });
});
