import { describe, expect, it, vi } from 'vitest';
import {
  ActiveExistingRowError,
  ghostObjectId,
  parseArgs,
  PartialRowMismatchError,
  provisionSupportAccount,
  provisionSupportAccountViaEngine,
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
    expect(() =>
      parseArgs(['--container', 'c1', '--email', 'x@example.com', '--status', 'active'])
    ).toThrow(/unrecognised argument/);
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
  it("is 24 lowercase hex characters, matching Ghost's own id shape", () => {
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
    const execFile = vi.fn(() =>
      JSON.stringify({ created: true, repaired: false, id: 'abc', status: 'inactive' })
    );
    const result = provisionSupportAccount(
      { container: 'my-container', email: 'support@example.com' },
      execFile
    );
    expect(result).toEqual({ created: true, repaired: false, id: 'abc', status: 'inactive' });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args] = execFile.mock.calls[0];
    expect(command).toBe('docker');
    expect(args[0]).toBe('exec');
    expect(args).toContain('my-container');
    // The email is data handed through an env pair, not interpolated into
    // the inline script text argv itself.
    const envIndex = args.indexOf('-e');
    expect(
      args
        .slice(envIndex, envIndex + 8)
        .some((a) => a === 'PROVISION_SUPPORT_EMAIL=support@example.com')
    ).toBe(true);
    expect(args.join(' ')).not.toContain('support@example.com\n');
  });

  it('reports an existing, complete row untouched rather than re-suspending or re-minting a password', () => {
    const execFile = vi.fn(() =>
      JSON.stringify({ created: false, repaired: false, id: 'existing-id', status: 'active' })
    );
    const result = provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile);
    expect(result).toEqual({
      created: false,
      repaired: false,
      id: 'existing-id',
      status: 'active',
    });
  });

  it('passes through a repaired-row report from the inner script unchanged', () => {
    const execFile = vi.fn(() =>
      JSON.stringify({ created: false, repaired: true, id: 'existing-id', status: 'inactive' })
    );
    const result = provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile);
    expect(result).toEqual({
      created: false,
      repaired: true,
      id: 'existing-id',
      status: 'inactive',
    });
  });

  it('never passes a --status-like flag that could create the account active -- there is no argument for it', () => {
    const execFile = vi.fn(() =>
      JSON.stringify({ created: true, repaired: false, id: 'abc', status: 'inactive' })
    );
    provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile);
    const [, args] = execFile.mock.calls[0];
    expect(args.join(' ')).not.toMatch(/PROVISION_SUPPORT_STATUS/);
  });

  it('re-throws a marked partial-row-mismatch failure as PartialRowMismatchError, with the mismatch detail as the message', () => {
    const execError = new Error('Command failed');
    execError.stderr =
      'Error: PARTIAL_ROW_MISMATCH: {"id":"x","status":"active","hasRoleLink":false} does not match an interrupted create (needs status "inactive" and no role link at all)\n    at main (/inner-script.js:1:1)\n';
    const execFile = vi.fn(() => {
      throw execError;
    });
    let caught;
    try {
      provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PartialRowMismatchError);
    expect(caught.message).toContain('"status":"active"');
    expect(caught.message).not.toContain('at main');
  });

  it('re-throws a marked active-existing-row failure as ActiveExistingRowError, with the row detail as the message', () => {
    const execError = new Error('Command failed');
    execError.stderr =
      'Error: ACTIVE_EXISTING_ROW: {"id":"x","status":"active"} an existing Administrator row for this email is not suspended -- refusing to report provisioning as successful\n    at main (/inner-script.js:1:1)\n';
    const execFile = vi.fn(() => {
      throw execError;
    });
    let caught;
    try {
      provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActiveExistingRowError);
    expect(caught.message).toContain('"status":"active"');
    expect(caught.message).not.toContain('at main');
  });

  it('re-throws an unrelated exec failure unchanged -- the marker match is exact, not a generic catch-all', () => {
    const execError = new Error('Command failed');
    execError.stderr = 'Error: something else entirely broke\n';
    const execFile = vi.fn(() => {
      throw execError;
    });
    expect(() =>
      provisionSupportAccount({ container: 'c1', email: 'x@example.com' }, execFile)
    ).toThrow(execError);
  });
});

describe('provisionSupportAccountViaEngine', () => {
  const engineReturning = (result) => ({ exec: vi.fn(async () => result) });

  it('runs the same inner script through the Engine client, with the account in env only', async () => {
    const engine = engineReturning({
      code: 0,
      stdout: `${JSON.stringify({ created: true, repaired: false, id: 'abc', status: 'inactive' })}\n`,
      stderr: '',
    });
    const result = await provisionSupportAccountViaEngine(
      { container: 'c1', email: 'x@example.com' },
      engine
    );
    expect(result).toEqual({ created: true, repaired: false, id: 'abc', status: 'inactive' });
    const request = engine.exec.mock.calls[0][0];
    expect(request.container).toBe('c1');
    expect(request.env).toContain('PROVISION_SUPPORT_EMAIL=x@example.com');
    expect(request.env.map((e) => e.split('=')[0])).toEqual([
      'PROVISION_SUPPORT_EMAIL',
      'PROVISION_SUPPORT_ID',
      'PROVISION_SUPPORT_PASSWORD_HASH',
      'PROVISION_SUPPORT_ROLE_LINK_ID',
      'PROVISION_SUPPORT_NOW',
    ]);
    expect(request.cmd.slice(0, 2)).toEqual(['node', '-e']);
    expect(request.cmd[2]).not.toContain('x@example.com');
  });

  it('re-throws the two named refusals as their own classes', async () => {
    const partial = engineReturning({
      code: 1,
      stdout: '',
      stderr: 'Error: PARTIAL_ROW_MISMATCH: {"id":"x"} does not match\n    at main\n',
    });
    await expect(
      provisionSupportAccountViaEngine({ container: 'c', email: 'x@example.com' }, partial)
    ).rejects.toBeInstanceOf(PartialRowMismatchError);
    const active = engineReturning({
      code: 1,
      stdout: '',
      stderr: 'Error: ACTIVE_EXISTING_ROW: {"id":"x"} not suspended\n',
    });
    await expect(
      provisionSupportAccountViaEngine({ container: 'c', email: 'x@example.com' }, active)
    ).rejects.toBeInstanceOf(ActiveExistingRowError);
  });

  it('reports any other non-zero exit with its code and stderr', async () => {
    const engine = engineReturning({ code: 2, stdout: '', stderr: 'Error: boom\n' });
    await expect(
      provisionSupportAccountViaEngine({ container: 'c', email: 'x@example.com' }, engine)
    ).rejects.toThrow(/exited 2: Error: boom/);
  });
});
