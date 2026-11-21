import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readConfig } = require('../../verdict-host/config.js');
const { VerdictHostConfigError } = require('../../verdict-host/config-error.js');

const base = {
  VERDICT_HOST_SOCKET: '/run/vh/v.sock',
  VERDICT_HOST_SOCKET_UID: '30007',
  VERDICT_HOST_SOCKET_GID: '30007',
  VERDICT_HOST_JOURNAL: '/var/lib/vh/queue.journal',
  VERDICT_HOST_VERIFY_KEY_FILE: '/etc/vh/channel-signing.pub',
  VERDICT_HOST_METRICS_FILE: '/var/lib/node_exporter/vh.prom',
  VERDICT_HOST_INBOUND_PORT: '8443',
};
const withTls = {
  ...base,
  VERDICT_HOST_TLS_CERT_FILE: '/var/lib/vh/tls.crt',
  VERDICT_HOST_TLS_KEY_FILE: '/var/lib/vh/tls.key',
};
const withMode = { ...withTls, VERDICT_HOST_INBOUND_TLS: 'pinned-private' };

describe('TLS settings', () => {
  it('leave TLS off, and the loopback rule as it was, when none is set', () => {
    const config = readConfig(base);
    expect(config.tlsCertFile).toBeUndefined();
    expect(config.tlsKeyFile).toBeUndefined();
    expect(() => readConfig({ ...base, VERDICT_HOST_INBOUND_HOST: '10.0.0.5' })).toThrow(
      'VERDICT_HOST_INBOUND_HOST must be a loopback address'
    );
  });

  it('turn TLS on with both paths, and carry them', () => {
    const config = readConfig({ ...withMode, VERDICT_HOST_INBOUND_HOST: '10.1.2.3' });
    expect(config).toMatchObject({
      tlsCertFile: '/var/lib/vh/tls.crt',
      tlsKeyFile: '/var/lib/vh/tls.key',
      inboundHost: '10.1.2.3',
    });
  });

  it('turn TLS on with both paths and no mode: the paths are never served plain', () => {
    expect(readConfig(withTls).tlsCertFile).toBe('/var/lib/vh/tls.crt');
  });

  it.each([
    '127.0.0.1',
    '127.9.9.9',
    '::1',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.255.254',
    'fd00::1',
    'fc00::1',
    'FDAB:1:2::3',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ])('accept the loopback or private address %s with TLS', (host) => {
    expect(readConfig({ ...withMode, VERDICT_HOST_INBOUND_HOST: host }).inboundHost).toBe(host);
  });

  it.each([
    '0.0.0.0',
    '::',
    '0:0:0:0:0:0:0:0',
    '8.8.8.8',
    '11.0.0.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.167.1.1',
    '192.169.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '2001:db8::1',
    'fe80::1',
    'fb00::1',
    'fe00::1',
    '::ffff:10.0.0.1',
    'fd00::1%eth0',
    'fd00::1]@[::2',
    'localhost',
    'host.example',
    '010.0.0.1',
    '10.0.0.1/8',
    '',
  ])('refuse the address %j with TLS, naming the variable', (host) => {
    const attempt = () => readConfig({ ...withMode, VERDICT_HOST_INBOUND_HOST: host });
    expect(attempt).toThrow('VERDICT_HOST_INBOUND_HOST');
    expect(attempt).toThrow(VerdictHostConfigError);
  });

  it.each([
    [
      'only the certificate path',
      { VERDICT_HOST_TLS_KEY_FILE: undefined },
      'VERDICT_HOST_TLS_KEY_FILE',
    ],
    ['only the key path', { VERDICT_HOST_TLS_CERT_FILE: undefined }, 'VERDICT_HOST_TLS_CERT_FILE'],
    [
      'only the certificate path, with the mode',
      { VERDICT_HOST_TLS_KEY_FILE: undefined, VERDICT_HOST_INBOUND_TLS: 'pinned-private' },
      'VERDICT_HOST_TLS_KEY_FILE',
    ],
    [
      'a relative certificate path',
      { VERDICT_HOST_TLS_CERT_FILE: 'tls.crt' },
      'VERDICT_HOST_TLS_CERT_FILE must be an absolute path',
    ],
    [
      'a relative key path',
      { VERDICT_HOST_TLS_KEY_FILE: 'tls.key' },
      'VERDICT_HOST_TLS_KEY_FILE must be an absolute path',
    ],
    ['an empty key path', { VERDICT_HOST_TLS_KEY_FILE: '' }, 'VERDICT_HOST_TLS_KEY_FILE'],
    ['an unknown mode', { VERDICT_HOST_INBOUND_TLS: 'on' }, 'VERDICT_HOST_INBOUND_TLS'],
    ['an empty mode', { VERDICT_HOST_INBOUND_TLS: '' }, 'VERDICT_HOST_INBOUND_TLS'],
    [
      'a mode in other case',
      { VERDICT_HOST_INBOUND_TLS: 'Pinned-Private' },
      'VERDICT_HOST_INBOUND_TLS',
    ],
  ])('refuse %s', (_name, change, message) => {
    expect(() => readConfig({ ...withTls, ...change })).toThrow(message);
  });

  it('refuse the mode with no paths: the descriptor says TLS, so plain is never served', () => {
    const attempt = () => readConfig({ ...base, VERDICT_HOST_INBOUND_TLS: 'pinned-private' });
    expect(attempt).toThrow('VERDICT_HOST_TLS_CERT_FILE');
    expect(attempt).toThrow(VerdictHostConfigError);
  });

  it('refuse the mode with a private address and no paths', () => {
    expect(() =>
      readConfig({
        ...base,
        VERDICT_HOST_INBOUND_TLS: 'pinned-private',
        VERDICT_HOST_INBOUND_HOST: '10.0.0.1',
      })
    ).toThrow('VERDICT_HOST_TLS_CERT_FILE');
  });
});
