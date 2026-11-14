import { describe, expect, it } from 'vitest';
import { loadConsoleConfig } from '../src/console/config.js';
import { ConfigError } from '../src/shell/config.js';

const OUTPUTS = JSON.stringify({
  ownerOrgId: 'org-owner',
  projectId: 'project-1',
  tenantOrgIds: { alpha: 'org-a' },
  clientIds: { console: 'client-console', portal: 'client-portal' },
});

const files: Record<string, string> = {
  '/outputs.json': OUTPUTS,
  '/db-url': 'postgres://login@db/portal\n',
  '/owner-credential': 'TEST_OWNER_CREDENTIAL\n',
  '/empty': '\n',
};
const read = (path: string): string => {
  const content = files[path];
  if (content === undefined) throw new Error('missing');
  return content;
};

const base = {
  CONSOLE_OUTPUTS_FILE: '/outputs.json',
  CONSOLE_PUBLIC_ORIGIN: 'https://console.example.test',
  CONSOLE_ISSUER_URL: 'https://id.example.test',
  CONSOLE_DATABASE_URL_FILE: '/db-url',
};

const provisioned = {
  ...base,
  CONSOLE_PROVISIONING_URL: 'https://provisioning.example.test',
  CONSOLE_PROVISIONING_CREDENTIAL_FILE: '/owner-credential',
};

describe('the owner console provisioning variables', () => {
  it('reads the origin from a variable and the credential from a file', () => {
    expect(loadConsoleConfig(provisioned, read).provisioning).toEqual({
      baseUrl: 'https://provisioning.example.test',
      ownerCredential: 'TEST_OWNER_CREDENTIAL',
    });
  });

  it('accepts plain http for loopback alone', () => {
    const local = { ...provisioned, CONSOLE_PROVISIONING_URL: 'http://127.0.0.1:8095' };
    expect(loadConsoleConfig(local, read).provisioning?.baseUrl).toBe('http://127.0.0.1:8095');
    const remote = { ...provisioned, CONSOLE_PROVISIONING_URL: 'http://provisioning.example.test' };
    expect(() => loadConsoleConfig(remote, read)).toThrow('https');
  });

  it('configures nothing when neither variable is set', () => {
    expect(loadConsoleConfig(base, read).provisioning).toBeUndefined();
    expect(
      loadConsoleConfig(
        { ...base, CONSOLE_PROVISIONING_URL: '', CONSOLE_PROVISIONING_CREDENTIAL_FILE: '' },
        read
      ).provisioning
    ).toBeUndefined();
  });

  it('stops at start when only one of the two is set', () => {
    const urlOnly = { ...base, CONSOLE_PROVISIONING_URL: provisioned.CONSOLE_PROVISIONING_URL };
    expect(() => loadConsoleConfig(urlOnly, read)).toThrow('CONSOLE_PROVISIONING_CREDENTIAL_FILE');
    const fileOnly = {
      ...base,
      CONSOLE_PROVISIONING_CREDENTIAL_FILE: provisioned.CONSOLE_PROVISIONING_CREDENTIAL_FILE,
    };
    expect(() => loadConsoleConfig(fileOnly, read)).toThrow('CONSOLE_PROVISIONING_URL');
  });

  it('stops at start on a URL that is not an origin, or a credential file with nothing in it', () => {
    for (const bad of [
      'not a url',
      'https://provisioning.example.test/path',
      'https://provisioning.example.test/?q=1',
      'https://user@provisioning.example.test',
    ]) {
      expect(() =>
        loadConsoleConfig({ ...provisioned, CONSOLE_PROVISIONING_URL: bad }, read)
      ).toThrow(ConfigError);
    }
    expect(() =>
      loadConsoleConfig({ ...provisioned, CONSOLE_PROVISIONING_CREDENTIAL_FILE: '/empty' }, read)
    ).toThrow('empty');
  });
});
