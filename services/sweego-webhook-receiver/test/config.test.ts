import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const SECRET_TEXT = Buffer.from('SECRET_PLACEHOLDER_BYTES_0123456789').toString('base64');
const TOKEN_TEXT = 'DRAIN_TOKEN_PLACEHOLDER_0123456789ABCDEF\n';

const files: Record<string, string> = {
  '/s/current': SECRET_TEXT + '\n',
  '/s/previous': Buffer.from('PREVIOUS_PLACEHOLDER_BYTES_012345').toString('base64'),
  '/s/token': TOKEN_TEXT,
  '/s/short-token': 'short',
  '/s/bad-secret': 'not base64!!',
  '/s/tiny-secret': Buffer.from('tiny').toString('base64'),
};

const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) {
    throw new Error(`ENOENT ${path}`);
  }
  return text;
};

const base: Record<string, string | undefined> = {
  WEBHOOK_HOST: '10.0.0.5',
  WEBHOOK_PORT: '8080',
  WEBHOOK_DRAIN_HOST: '10.0.0.5',
  WEBHOOK_DRAIN_PORT: '8081',
  WEBHOOK_SECRET_FILE: '/s/current',
  WEBHOOK_DRAIN_TOKEN_FILE: '/s/token',
  WEBHOOK_STATE_DIR: '/state',
};

describe('loadConfig', () => {
  it('loads one secret, trims the token, and defaults the timeouts', () => {
    const config = loadConfig(base, read);
    expect(config.secrets).toHaveLength(1);
    expect(config.drainToken).toBe(TOKEN_TEXT.trim());
    expect(config.headersTimeoutMs).toBe(5000);
    expect(config.outcomeHeader).toBeUndefined();
  });

  it('loads the previous secret for a rotation and lower-cases the outcome header', () => {
    const config = loadConfig(
      {
        ...base,
        WEBHOOK_SECRET_FILE_PREVIOUS: '/s/previous',
        WEBHOOK_OUTCOME_HEADER: 'X-Outcome-Id',
      },
      read
    );
    expect(config.secrets).toHaveLength(2);
    expect(config.outcomeHeader).toBe('x-outcome-id');
  });

  it.each([
    'WEBHOOK_HOST',
    'WEBHOOK_PORT',
    'WEBHOOK_DRAIN_HOST',
    'WEBHOOK_DRAIN_PORT',
    'WEBHOOK_SECRET_FILE',
    'WEBHOOK_DRAIN_TOKEN_FILE',
    'WEBHOOK_STATE_DIR',
  ])('refuses to start without %s', (name) => {
    const env = { ...base };
    delete env[name];
    expect(() => loadConfig(env, read)).toThrow(name);
  });

  it.each(['0.0.0.0', '::', ''])('refuses the wildcard address %j for either listener', (host) => {
    expect(() => loadConfig({ ...base, WEBHOOK_HOST: host }, read)).toThrow();
    expect(() => loadConfig({ ...base, WEBHOOK_DRAIN_HOST: host }, read)).toThrow();
  });

  it.each(['0', '70000', 'abc', '80.5'])('refuses port %j', (value) => {
    expect(() => loadConfig({ ...base, WEBHOOK_PORT: value }, read)).toThrow('port');
  });

  it('refuses the two listeners sharing one address and port', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_DRAIN_PORT: '8080' }, read)).toThrow('share');
  });

  it('refuses a short drain token, a non-base64 secret and a tiny secret', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_DRAIN_TOKEN_FILE: '/s/short-token' }, read)).toThrow(
      'token'
    );
    expect(() => loadConfig({ ...base, WEBHOOK_SECRET_FILE: '/s/bad-secret' }, read)).toThrow(
      'base64'
    );
    expect(() => loadConfig({ ...base, WEBHOOK_SECRET_FILE: '/s/tiny-secret' }, read)).toThrow(
      '16 bytes'
    );
  });

  it('refuses a missing secret file rather than starting without one', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_SECRET_FILE: '/s/absent' }, read)).toThrow('ENOENT');
  });
});
