import { describe, expect, it, vi } from 'vitest';
import {
  OwnerProvisionRefusedError,
  parseArgs,
  provisionOwner,
} from '../../scripts/provision-owner.mjs';

const GOOD = [
  '--container',
  'c1',
  '--email',
  'owner@example.com',
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
      email: 'owner@example.com',
      name: 'OWNER_NAME',
      siteUrl: 'https://tenant.example.com',
      siteTitle: 'SITE_TITLE',
    });
  });

  it.each(['--container', '--email', '--name', '--site-url', '--site-title'])(
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

  it('refuses an email that is not an address', () => {
    expect(() =>
      parseArgs(GOOD.map((v) => (v === 'owner@example.com' ? 'not-an-address' : v)))
    ).toThrow(/email address/);
  });
});

describe('provisionOwner', () => {
  const input = {
    container: 'my-container',
    email: 'owner@example.com',
    name: 'Zed Quux',
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

  it('passes values as env pairs, never inside the script text', () => {
    const execFile = vi.fn(() => '{"created":false,"alreadySetUp":true}');
    provisionOwner({ ...input, email: "o'wner@example.com" }, execFile);
    const args = execFile.mock.calls[0][1];
    const script = args[args.length - 1];
    expect(args).toContain("PROVISION_OWNER_EMAIL=o'wner@example.com");
    expect(script).not.toContain('example.com');
    expect(script).not.toContain('Zed Quux');
  });

  it('never passes a password: the container generates one and drops it', () => {
    const execFile = vi.fn(() => '{"created":true,"alreadySetUp":false,"linkRequested":true}');
    provisionOwner(input, execFile);
    const args = execFile.mock.calls[0][1];
    const envPairs = args.slice(0, -1).filter((a, i) => args[i - 1] === '-e');
    expect(envPairs.filter((pair) => /password/i.test(pair))).toEqual([]);
    const script = args[args.length - 1];
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

  it('compares an existing owner to --email before reporting a Ghost as set up', () => {
    const execFile = vi.fn(() => '{}');
    provisionOwner(input, execFile);
    const script = execFile.mock.calls[0][1].at(-1);
    const read = script.indexOf('await ownerEmail()');
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
