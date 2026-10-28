import { describe, expect, it } from 'vitest';
import {
  SUPPORT_VARIABLES,
  disabledLine,
  failureLine,
  loadSupportSettings,
} from '../src/tenant/supportConfig.js';
import { FAKE_RECIPIENT, FAKE_SENDER } from './supportHarness.js';

const PASSWORD_FILE = '/FAKE_PASSWORD_FILE';
const SECRET = 'PASSWORD_MARKER_c0de';

const VALID: Record<string, string> = {
  [SUPPORT_VARIABLES.host]: 'mx.example.org',
  [SUPPORT_VARIABLES.port]: '465',
  [SUPPORT_VARIABLES.security]: 'IMPLICIT',
  [SUPPORT_VARIABLES.user]: FAKE_SENDER,
  [SUPPORT_VARIABLES.passwordFile]: PASSWORD_FILE,
  [SUPPORT_VARIABLES.sender]: FAKE_SENDER,
  [SUPPORT_VARIABLES.recipient]: FAKE_RECIPIENT,
};

const reads =
  (contents: string) =>
  (path: string): string => {
    if (path !== PASSWORD_FILE) throw new Error('ENOENT');
    return contents;
  };

function without(...names: string[]): Record<string, string> {
  const copy = { ...VALID };
  for (const name of names) delete copy[name];
  return copy;
}

describe('support settings from the environment', () => {
  it('builds settings from a valid environment without connecting anywhere', () => {
    const { support, disabledBecause } = loadSupportSettings(VALID, reads(`${SECRET}\n`));
    expect(disabledBecause).toEqual([]);
    expect(support?.recipient).toBe(FAKE_RECIPIENT);
    expect(support?.sender).toBe(FAKE_SENDER);
    expect(typeof support?.mailer.send).toBe('function');
  });

  it('defaults to port 587 and STARTTLS, and accepts a trimmed credential file', () => {
    const env = without(SUPPORT_VARIABLES.port, SUPPORT_VARIABLES.security);
    const { support, disabledBecause } = loadSupportSettings(env, reads(`  ${SECRET}\n\n`));
    expect(disabledBecause).toEqual([]);
    expect(support).toBeDefined();
  });

  it('accepts STARTTLS spelled out and an address in another letter case', () => {
    const env = {
      ...VALID,
      [SUPPORT_VARIABLES.security]: 'STARTTLS',
      [SUPPORT_VARIABLES.sender]: FAKE_SENDER.toUpperCase(),
    };
    expect(loadSupportSettings(env, reads(SECRET)).support).toBeDefined();
  });

  it.each(Object.values(SUPPORT_VARIABLES).filter((name) => !/PORT$|SECURITY$/.test(name)))(
    'is off, and names %s, when it is missing',
    (name) => {
      const env = without(name);
      const { support, disabledBecause } = loadSupportSettings(env, reads(SECRET));
      expect(support).toBeUndefined();
      expect(disabledBecause).toContain(name);
    }
  );

  it.each([
    [SUPPORT_VARIABLES.port, '0'],
    [SUPPORT_VARIABLES.port, 'not-a-port'],
    [SUPPORT_VARIABLES.port, '70000'],
    [SUPPORT_VARIABLES.security, 'NONE'],
    [SUPPORT_VARIABLES.security, 'starttls'],
    [SUPPORT_VARIABLES.security, ''],
    [SUPPORT_VARIABLES.host, '   '],
    [SUPPORT_VARIABLES.recipient, 'two@example.org,three@example.org'],
    [SUPPORT_VARIABLES.recipient, 'not-an-address'],
    [SUPPORT_VARIABLES.recipient, 'a@example.org\nBcc: b@example.org'],
  ])('is off, naming only %s, when it is %j', (name, value) => {
    const { support, disabledBecause } = loadSupportSettings(
      { ...VALID, [name]: value },
      reads(SECRET)
    );
    expect(support).toBeUndefined();
    expect(disabledBecause).toEqual([name]);
  });

  it.each([
    ['an unreadable file', () => reads('')('/ELSEWHERE')],
    ['an empty file', () => ''],
    ['a file of whitespace', () => ' \n '],
  ])('is off, naming only the credential file variable, for %s', (_label, contents) => {
    const read = (): string => contents();
    const { support, disabledBecause } = loadSupportSettings(VALID, read);
    expect(support).toBeUndefined();
    expect(disabledBecause).toEqual([SUPPORT_VARIABLES.passwordFile]);
  });

  it('refuses a sender that differs from the SMTP user, naming exactly those two variables', () => {
    const env = { ...VALID, [SUPPORT_VARIABLES.sender]: 'someone-else@example.org' };
    const { support, disabledBecause } = loadSupportSettings(env, reads(SECRET));
    expect(support).toBeUndefined();
    expect(disabledBecause).toEqual([SUPPORT_VARIABLES.sender, SUPPORT_VARIABLES.user]);
  });

  it('refuses an SMTP user that is not an address, naming the sender and the user', () => {
    const env = { ...VALID, [SUPPORT_VARIABLES.user]: 'a-login-name' };
    const { support, disabledBecause } = loadSupportSettings(env, reads(SECRET));
    expect(support).toBeUndefined();
    expect(disabledBecause).toEqual([SUPPORT_VARIABLES.user, SUPPORT_VARIABLES.sender]);
  });

  it('reports every problem at once and never a value', () => {
    const env = {
      ...VALID,
      [SUPPORT_VARIABLES.port]: 'nope',
      [SUPPORT_VARIABLES.recipient]: 'FAKE_BAD_RECIPIENT',
    };
    const { support, disabledBecause } = loadSupportSettings(env, reads(SECRET));
    expect(support).toBeUndefined();
    expect(disabledBecause).toEqual([SUPPORT_VARIABLES.port, SUPPORT_VARIABLES.recipient]);
    const printed = JSON.stringify(disabledBecause);
    for (const value of ['nope', 'FAKE_BAD_RECIPIENT', SECRET, FAKE_SENDER, PASSWORD_FILE]) {
      expect(printed).not.toContain(value);
    }
  });

  it('is off with every name listed when nothing is set', () => {
    const { support, disabledBecause } = loadSupportSettings({}, reads(SECRET));
    expect(support).toBeUndefined();
    expect(disabledBecause).toEqual([
      SUPPORT_VARIABLES.host,
      SUPPORT_VARIABLES.user,
      SUPPORT_VARIABLES.passwordFile,
      SUPPORT_VARIABLES.sender,
      SUPPORT_VARIABLES.recipient,
    ]);
  });

  it('never puts the password in the settings it returns on failure', () => {
    const { disabledBecause } = loadSupportSettings(without(SUPPORT_VARIABLES.host), reads(SECRET));
    expect(JSON.stringify(disabledBecause)).not.toContain(SECRET);
  });
});

describe('the two stderr lines', () => {
  it('names the variables and nothing else', () => {
    const line = disabledLine([SUPPORT_VARIABLES.host, SUPPORT_VARIABLES.sender]);
    expect(JSON.parse(line)).toEqual({
      event: 'support_disabled',
      variables: [SUPPORT_VARIABLES.host, SUPPORT_VARIABLES.sender],
    });
    expect(line).not.toContain('\n');
  });

  it('carries the short code of a failed send and nothing else', () => {
    expect(JSON.parse(failureLine('AUTH_FAILED'))).toEqual({
      event: 'support_send_failed',
      code: 'AUTH_FAILED',
    });
  });
});
