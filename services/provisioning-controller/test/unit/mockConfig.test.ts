import { describe, expect, it } from 'vitest';
import { MockConfigError, readConfig } from '../../mock/config.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const valid = {
  MOCK_OWNER_CREDENTIAL: 'TEST_OWNER',
  MOCK_TENANT_CREDENTIALS: `${TENANT}=TEST_ONE,${OTHER}=TEST_TWO`,
};

describe('the mock configuration', () => {
  it('reads the credentials, the tenants and the defaults', () => {
    const config = readConfig(valid);
    expect(config.port).toBe(8095);
    expect(config.host).toBe('127.0.0.1');
    expect(config.credentials.owner).toBe('TEST_OWNER');
    expect(config.credentials.tenants.get('TEST_TWO')).toBe(OTHER);
    expect(config.tenants).toEqual([TENANT, OTHER]);
  });

  it('takes a port and a host from the environment', () => {
    const config = readConfig({ ...valid, PORT: '0', LISTEN_HOST: '::1' });
    expect(config.port).toBe(0);
    expect(config.host).toBe('::1');
  });

  it('refuses to start without the owner credential or any tenant credential', () => {
    expect(() => readConfig({ MOCK_TENANT_CREDENTIALS: valid.MOCK_TENANT_CREDENTIALS })).toThrow(
      MockConfigError
    );
    expect(() => readConfig({ MOCK_OWNER_CREDENTIAL: 'TEST_OWNER' })).toThrow(MockConfigError);
    expect(() => readConfig({ MOCK_OWNER_CREDENTIAL: '', MOCK_TENANT_CREDENTIALS: '' })).toThrow(
      MockConfigError
    );
  });

  it('refuses a malformed pair, a repeated credential or tenant, and an owner credential reused', () => {
    for (const pairs of [
      'not-a-pair',
      `${TENANT}=`,
      `not-a-uuid=TEST_ONE`,
      `${TENANT}=TEST_ONE,${OTHER}=TEST_ONE`,
      `${TENANT}=TEST_ONE,${TENANT}=TEST_TWO`,
      `${TENANT}=TEST_OWNER`,
    ]) {
      expect(
        () => readConfig({ MOCK_OWNER_CREDENTIAL: 'TEST_OWNER', MOCK_TENANT_CREDENTIALS: pairs }),
        pairs
      ).toThrow(MockConfigError);
    }
  });

  it('refuses a port that is not a port', () => {
    for (const port of ['abc', '-1', '70000', '80.5']) {
      expect(() => readConfig({ ...valid, PORT: port }), port).toThrow(MockConfigError);
    }
  });
});
