import { describe, expect, it, vi } from 'vitest';
import {
  ghostObjectId,
  parseArgs,
  provisionSupportAccount,
  SUSPENDED_STATUS,
  unusablePasswordHash,
} from '../../scripts/provision-support-account.mjs';

describe('parseArgs', () => {
  it('parses --container and --email', () => {
    expect(parseArgs(['--container', 'c1', '--email', 'support@example.com'])).toEqual({
      container: 'c1',
      email: 'support@example.com',
    });
  });

  it('refuses a missing --container', () => {
    expect(() => parseArgs(['--email', 'support@example.com'])).toThrow(/--container/);
  });

  it('refuses a missing --email', () => {
    expect(() => parseArgs(['--container', 'c1'])).toThrow(/--email/);
  });

  it('refuses an unrecognised flag -- never silently ignored', () => {
    expect(() => parseArgs(['--container', 'c1', '--email', 'x@example.com', '--status', 'active'])).toThrow(
      /unrecognised argument/
    );
  });
});

describe('unusablePasswordHash', () => {
  it('is bcrypt-shaped: "$2a$10$" plus up to 53 further alphanumeric characters', () => {
    // Stripping base64's own "+/=" before slicing (see the implementation's
    // own comment) means the alphanumeric remainder can land under 53
    // characters when the random bytes happened to contain some of those —
    // exactness isn't the property under test here, only the shape and a
    // floor generous enough that no real run is ever this unlucky.
    const hash = unusablePasswordHash();
    expect(hash).toMatch(/^\$2a\$10\$[A-Za-z0-9]{40,53}$/);
  });

  it('is different on every call -- never a fixed, guessable value', () => {
    const a = unusablePasswordHash();
    const b = unusablePasswordHash();
    expect(a).not.toBe(b);
  });
});

describe('ghostObjectId', () => {
  it('is 24 lowercase hex characters, matching Ghost\'s own id shape', () => {
    expect(ghostObjectId()).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('SUSPENDED_STATUS', () => {
  it('is "inactive" -- Ghost\'s own storage value for a suspended account', () => {
    expect(SUSPENDED_STATUS).toBe('inactive');
  });
});

describe('provisionSupportAccount', () => {
  it('shells out to "docker exec" against the named container, passing the email through the env rather than the argv text', () => {
    const execFile = vi.fn(() => JSON.stringify({ created: true, id: 'abc', status: 'inactive' }));
    const result = provisionSupportAccount(
      { container: 'my-container', email: 'support@example.com' },
      execFile
    );
    expect(result).toEqual({ created: true, id: 'abc', status: 'inactive' });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args] = execFile.mock.calls[0];
    expect(command).toBe('docker');
    expect(args[0]).toBe('exec');
    expect(args).toContain('my-container');
    // The email is data handed through an env pair, not interpolated into
    // the inline script text argv itself.
    const envIndex = args.indexOf('-e');
    expect(args.slice(envIndex, envIndex + 8).some((a) => a === 'PROVISION_SUPPORT_EMAIL=support@example.com')).toBe(
      true
    );
    expect(args.join(' ')).not.toContain('support@example.com\n');
  });

  it('reports an existing row untouched rather than re-suspending or re-minting a password', () => {
    const execFile = vi.fn(() =>
      JSON.stringify({ created: false, id: 'existing-id', status: 'active' })
    );
    const result = provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile);
    expect(result).toEqual({ created: false, id: 'existing-id', status: 'active' });
  });

  it('never passes a --status-like flag that could create the account active -- there is no argument for it', () => {
    const execFile = vi.fn(() => JSON.stringify({ created: true, id: 'abc', status: 'inactive' }));
    provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile);
    const [, args] = execFile.mock.calls[0];
    expect(args.join(' ')).not.toMatch(/PROVISION_SUPPORT_STATUS/);
  });
});
