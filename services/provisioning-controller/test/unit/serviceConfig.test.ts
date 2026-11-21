import { describe, expect, it } from 'vitest';
import { ServiceConfigError, readServiceConfig } from '../../src/service/config.js';

const valid = {
  PROVISIONING_OWNER_CREDENTIAL_FILE: '/run/owner',
  PROVISIONING_TENANT_CREDENTIALS_FILE: '/run/tenants',
  PROVISIONING_DEMOS_FILE: '/run/demos.json',
  PROVISIONING_STATE_DIR: '/state',
};

describe('the service configuration', () => {
  it('reads four paths and defaults to loopback on 8095', () => {
    expect(readServiceConfig(valid)).toEqual({
      port: 8095,
      host: '127.0.0.1',
      ownerCredentialFile: '/run/owner',
      tenantCredentialsFile: '/run/tenants',
      demosFile: '/run/demos.json',
      stateDir: '/state',
    });
  });

  it('takes a port and a listen address from the environment', () => {
    const config = readServiceConfig({ ...valid, PORT: '0', LISTEN_HOST: '0.0.0.0' });
    expect([config.port, config.host]).toEqual([0, '0.0.0.0']);
  });

  it.each(Object.keys(valid))('refuses to start without %s, naming it', (name) => {
    const { [name]: _removed, ...rest } = valid as Record<string, string>;
    expect(() => readServiceConfig(rest)).toThrow(new ServiceConfigError(`${name} is not set`));
  });

  it.each(Object.keys(valid))('refuses a relative path in %s', (name) => {
    expect(() => readServiceConfig({ ...valid, [name]: 'relative/path' })).toThrow(
      'must be an absolute path'
    );
  });

  it('refuses a port that is not one', () => {
    expect(() => readServiceConfig({ ...valid, PORT: 'eighty' })).toThrow('PORT');
    expect(() => readServiceConfig({ ...valid, PORT: '70000' })).toThrow('PORT');
  });
});
