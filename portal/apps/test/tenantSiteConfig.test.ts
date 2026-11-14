import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '../../data/test/helpers.js';
import {
  loadProvisioningSettings,
  PROVISIONING_VARIABLES,
  provisioningDisabledLine,
} from '../src/tenant/siteConfig.js';

const URL_VARIABLE = PROVISIONING_VARIABLES.url;
const FILE_VARIABLE = PROVISIONING_VARIABLES.credentialsFile;
const FILE = '/run/provisioning-credentials';
const LINES = `${TENANT_A}=TEST_CREDENTIAL_A\n\n${TENANT_B}=TEST_CREDENTIAL_B\n`;

const reading = (text: string) => (path: string) => {
  if (path !== FILE) throw new Error('unexpected path');
  return text;
};

describe('loading the provisioning API settings', () => {
  it('reads the address and one credential per tenant', () => {
    const load = loadProvisioningSettings(
      { [URL_VARIABLE]: 'http://127.0.0.1:8095/', [FILE_VARIABLE]: FILE },
      reading(LINES)
    );
    expect(load.disabledBecause).toEqual([]);
    expect(load.provisioning?.baseUrl).toBe('http://127.0.0.1:8095');
    expect(load.provisioning?.credentialFor(TENANT_A)).toBe('TEST_CREDENTIAL_A');
    expect(load.provisioning?.credentialFor(TENANT_B)).toBe('TEST_CREDENTIAL_B');
    expect(
      load.provisioning?.credentialFor('33333333-3333-4333-8333-333333333333')
    ).toBeUndefined();
  });

  it.each([
    ['no address', {}, LINES, [URL_VARIABLE]],
    [
      'an address that is not http',
      { [URL_VARIABLE]: 'ftp://x.example.test' },
      LINES,
      [URL_VARIABLE],
    ],
    [
      'an address with a password in it',
      { [URL_VARIABLE]: 'https://u:p@x.example.test' },
      LINES,
      [URL_VARIABLE],
    ],
    [
      'an address with a query',
      { [URL_VARIABLE]: 'https://x.example.test/?a=1' },
      LINES,
      [URL_VARIABLE],
    ],
    ['an address that is not an address', { [URL_VARIABLE]: 'not a url' }, LINES, [URL_VARIABLE]],
    ['no credentials file', { [URL_VARIABLE]: 'https://x.example.test' }, LINES, [FILE_VARIABLE]],
  ])('is off with %s', (_name, env, text, variables) => {
    const withFile = variables.some((name) => name === FILE_VARIABLE)
      ? env
      : { ...env, [FILE_VARIABLE]: FILE };
    const load = loadProvisioningSettings(withFile, reading(text));
    expect(load.provisioning).toBeUndefined();
    expect(load.disabledBecause).toEqual(variables);
  });

  it.each([
    ['an empty file', ''],
    ['a line with no equals sign', 'TEST_CREDENTIAL_A\n'],
    ['a tenant that is not a UUID', 'tenant-a=TEST_CREDENTIAL_A\n'],
    ['an empty credential', `${TENANT_A}=\n`],
    ['a tenant listed twice', `${TENANT_A}=ONE\n${TENANT_A}=TWO\n`],
  ])('is off with %s in the credentials file', (_name, text) => {
    const load = loadProvisioningSettings(
      { [URL_VARIABLE]: 'https://x.example.test', [FILE_VARIABLE]: FILE },
      reading(text)
    );
    expect(load.provisioning).toBeUndefined();
    expect(load.disabledBecause).toEqual([FILE_VARIABLE]);
  });

  it('is off when the credentials file cannot be read', () => {
    const load = loadProvisioningSettings(
      { [URL_VARIABLE]: 'https://x.example.test', [FILE_VARIABLE]: FILE },
      () => {
        throw new Error('ENOENT');
      }
    );
    expect(load.provisioning).toBeUndefined();
    expect(load.disabledBecause).toEqual([FILE_VARIABLE]);
  });

  it('names variables in its log line and never a value', () => {
    const line = provisioningDisabledLine([URL_VARIABLE, FILE_VARIABLE]);
    expect(JSON.parse(line)).toEqual({
      event: 'provisioning_disabled',
      variables: [URL_VARIABLE, FILE_VARIABLE],
    });
  });
});
