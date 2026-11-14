import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/shell/config.js';
import { loadTenantConfig } from '../src/tenant/config.js';
import {
  loadProvisioningSettings,
  PROVISIONING_VARIABLES,
} from '../src/tenant/provisioningSettings.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CREDENTIALS_FILE = '/FAKE_CREDENTIALS_FILE';

const OUTPUTS = JSON.stringify({
  ownerOrgId: 'org-owner',
  projectId: 'project-1',
  tenantOrgIds: { alpha: 'org-a' },
  clientIds: { console: 'client-console', portal: 'client-portal' },
});

const files: Record<string, string> = {
  '/outputs.json': OUTPUTS,
  '/db-url': 'postgres://login@db/portal\n',
  [CREDENTIALS_FILE]: `${TENANT_A}=TEST_CREDENTIAL_A\n\n${TENANT_B}=TEST_CREDENTIAL_B\n`,
};
const read = (path: string): string => {
  const content = files[path];
  if (content === undefined) throw new Error('ENOENT');
  return content;
};

const URL_VARIABLE = PROVISIONING_VARIABLES.url;
const FILE_VARIABLE = PROVISIONING_VARIABLES.credentialsFile;

const BASE = {
  PORTAL_OUTPUTS_FILE: '/outputs.json',
  PORTAL_PUBLIC_ORIGIN: 'https://portal.example.test',
  PORTAL_ISSUER_URL: 'https://id.example.test',
  PORTAL_DATABASE_URL_FILE: '/db-url',
};

describe('the provisioning API settings', () => {
  it('are absent, and the portal has no demo screen, when the URL is unset or blank', () => {
    expect(loadProvisioningSettings({}, read)).toBeUndefined();
    expect(loadProvisioningSettings({ [URL_VARIABLE]: '  ' }, read)).toBeUndefined();
    expect(loadTenantConfig(BASE, read).provisioning).toBeUndefined();
  });

  it('give each tenant its own credential and nobody else a credential', () => {
    const settings = loadProvisioningSettings(
      { [URL_VARIABLE]: 'https://provisioning.example.test/', [FILE_VARIABLE]: CREDENTIALS_FILE },
      read
    );
    expect(settings?.baseUrl).toBe('https://provisioning.example.test');
    expect(settings?.credentialFor(TENANT_A)).toBe('TEST_CREDENTIAL_A');
    expect(settings?.credentialFor(TENANT_B)).toBe('TEST_CREDENTIAL_B');
    expect(settings?.credentialFor('33333333-3333-4333-8333-333333333333')).toBeUndefined();
    expect(settings?.credentialFor('__proto__')).toBeUndefined();
  });

  it('reach the tenant portal configuration', () => {
    const config = loadTenantConfig(
      { ...BASE, [URL_VARIABLE]: 'http://127.0.0.1:8095', [FILE_VARIABLE]: CREDENTIALS_FILE },
      read
    );
    expect(config.provisioning?.baseUrl).toBe('http://127.0.0.1:8095');
  });

  it('stop the process at start when a URL that is set cannot be used', () => {
    const withFile = { [FILE_VARIABLE]: CREDENTIALS_FILE };
    const bad: Record<string, string>[] = [
      { [URL_VARIABLE]: 'not a url', ...withFile },
      { [URL_VARIABLE]: 'http://provisioning.example.test', ...withFile },
      { [URL_VARIABLE]: 'https://user:secret@provisioning.example.test', ...withFile },
      { [URL_VARIABLE]: 'https://provisioning.example.test/?x=1', ...withFile },
      { [URL_VARIABLE]: 'https://provisioning.example.test' },
      { [URL_VARIABLE]: 'https://provisioning.example.test', [FILE_VARIABLE]: '/MISSING' },
    ];
    for (const env of bad) {
      expect(() => loadProvisioningSettings(env, read)).toThrow(ConfigError);
    }
  });

  it('refuse a credentials file that is empty, malformed or repeats a tenant or a credential', () => {
    const env = { [URL_VARIABLE]: 'https://provisioning.example.test', [FILE_VARIABLE]: '/F' };
    const refused = [
      '',
      'no equals sign',
      `${TENANT_A}=`,
      'not-a-uuid=TEST_CREDENTIAL',
      `${TENANT_A}=TEST_CREDENTIAL_A\n${TENANT_A}=TEST_CREDENTIAL_B`,
      `${TENANT_A}=SAME\n${TENANT_B}=SAME`,
    ];
    for (const contents of refused) {
      expect(() => loadProvisioningSettings(env, () => contents)).toThrow(ConfigError);
    }
  });

  it('never put a credential in an error', () => {
    const env = { [URL_VARIABLE]: 'https://provisioning.example.test', [FILE_VARIABLE]: '/F' };
    try {
      loadProvisioningSettings(env, () => `${TENANT_A}=SECRET_MARKER\n${TENANT_B}=SECRET_MARKER`);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('SECRET_MARKER');
    }
  });
});
