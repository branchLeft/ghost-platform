import { chmod, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV, MAX_BODY_CAP_MIB, loadConfig } from '../src/config.js';
import { MAX_UPLOAD_CEILING_MIB } from '../src/credentials/admin.js';
import { MasterSecretError } from '../src/credentials/masterSecret.js';
import { startGateway } from '../src/start.js';
import { MIB, startRig } from './support/gateway-rig.js';

const GOOD: Record<string, string> = {
  [ENV.region]: 'nbg1',
  [ENV.upstreamEndpoint]: 'https://storage.example.invalid',
  [ENV.upstreamKeyIdFile]: '/run/secrets/key-id',
  [ENV.upstreamSecretFile]: '/run/secrets/secret',
  [ENV.storePath]: '/var/lib/gw/credentials.sqlite',
  [ENV.storeAnchorPath]: '/var/lib/gw-anchor/generation',
  [ENV.spoolDir]: '/var/lib/gw/spool',
};

const without = (name: string): Record<string, string> => {
  const { [name]: _removed, ...rest } = GOOD;
  return rest;
};

describe('loadConfig', () => {
  it('reads a minimal environment and defaults the rest', () => {
    const config = loadConfig(GOOD);
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 8443 });
    expect(config.upstream.region).toBe('nbg1');
    expect(config.upstream.deadlineMs).toBe(120_000);
    expect(config.maxBodyBytes).toBe(MAX_BODY_CAP_MIB * MIB);
    expect(config.admin).toBeUndefined();
    expect(config.tls).toBeUndefined();
  });

  it('caps any one body at the largest ceiling a tenant may hold', () => {
    expect(MAX_BODY_CAP_MIB).toBe(MAX_UPLOAD_CEILING_MIB);
    expect(() => loadConfig({ ...GOOD, [ENV.maxBodyMib]: String(MAX_BODY_CAP_MIB + 1) })).toThrow(
      /between 1 and/
    );
    expect(loadConfig({ ...GOOD, [ENV.maxBodyMib]: '2' }).maxBodyBytes).toBe(2 * MIB);
  });

  it('bounds every timeout and limit, with defaults', () => {
    const config = loadConfig(GOOD);
    expect(config.requestTimeoutMs).toBe(300_000);
    expect(config.headersTimeoutMs).toBe(15_000);
    expect(config.keepAliveTimeoutMs).toBe(5000);
    expect(config.maxConnections).toBe(512);
    expect(config.maxConcurrentUploads).toBe(32);
    for (const [name, low, high] of [
      [ENV.headersTimeoutMs, '999', '120001'],
      [ENV.keepAliveTimeoutMs, '999', '120001'],
      [ENV.maxConnections, '0', '100001'],
      [ENV.maxConcurrentUploads, '0', '10001'],
    ] as const) {
      expect(() => loadConfig({ ...GOOD, [name]: low })).toThrow(name);
      expect(() => loadConfig({ ...GOOD, [name]: high })).toThrow(name);
    }
  });

  it('keeps the headers timeout inside the request timeout', () => {
    expect(() =>
      loadConfig({ ...GOOD, [ENV.requestTimeoutMs]: '5000', [ENV.headersTimeoutMs]: '6000' })
    ).toThrow(/must not exceed/);
    // A short request timeout alone pulls the headers default down with it.
    expect(loadConfig({ ...GOOD, [ENV.requestTimeoutMs]: '2000' }).headersTimeoutMs).toBe(2000);
  });

  it.each(Object.keys(GOOD))('refuses to start without %s', (name) => {
    expect(() => loadConfig(without(name))).toThrow(ConfigError);
    expect(() => loadConfig(without(name))).toThrow(new RegExp(name));
  });

  it('refuses a relative path for any file or directory setting', () => {
    for (const name of [
      ENV.upstreamKeyIdFile,
      ENV.upstreamSecretFile,
      ENV.storePath,
      ENV.storeAnchorPath,
      ENV.spoolDir,
    ]) {
      expect(() => loadConfig({ ...GOOD, [name]: 'relative/path' })).toThrow(/absolute path/);
    }
  });

  it('refuses a number that is not a whole number in range, without echoing it', () => {
    for (const bad of ['abc', '1.5', '-1', '70000']) {
      expect(() => loadConfig({ ...GOOD, [ENV.listenPort]: bad })).toThrow(ConfigError);
    }
    try {
      loadConfig({ ...GOOD, [ENV.listenPort]: 'SECRETISH' });
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRETISH');
    }
  });

  it('keeps plaintext to loopback unless TLS is set or a TLS proxy is declared', () => {
    const open = { ...GOOD, [ENV.listenHost]: '10.0.0.5' };
    expect(() => loadConfig(open)).toThrow(/no TLS is configured/);
    expect(loadConfig({ ...open, [ENV.plaintextBehindProxy]: 'true' }).listen.host).toBe(
      '10.0.0.5'
    );
    expect(
      loadConfig({
        ...open,
        [ENV.tlsCertFile]: '/run/tls/cert.pem',
        [ENV.tlsKeyFile]: '/run/tls/key.pem',
      }).tls
    ).toEqual({ certFile: '/run/tls/cert.pem', keyFile: '/run/tls/key.pem' });
    expect(() => loadConfig({ ...open, [ENV.plaintextBehindProxy]: 'yes' })).toThrow(
      /true or false/
    );
  });

  it('requires the TLS certificate and key together', () => {
    expect(() => loadConfig({ ...GOOD, [ENV.tlsCertFile]: '/run/tls/cert.pem' })).toThrow(
      /must be set together/
    );
  });

  it('serves the admin interface only when its keys file is named, and holds it to the same transport rule', () => {
    const admin = loadConfig({ ...GOOD, [ENV.adminKeysFile]: '/etc/gw/admin-keys.json' }).admin;
    expect(admin).toEqual({
      keysFile: '/etc/gw/admin-keys.json',
      host: '127.0.0.1',
      port: 8444,
      replayWindowSeconds: 60,
    });
    expect(() =>
      loadConfig({
        ...GOOD,
        [ENV.adminKeysFile]: '/etc/gw/admin-keys.json',
        [ENV.adminListenHost]: '0.0.0.0',
      })
    ).toThrow(ENV.adminListenHost);
  });

  it('binds the admin interface to loopback unless the host is told, in so many words, that it may leave it', () => {
    const behindProxy = {
      ...GOOD,
      [ENV.adminKeysFile]: '/etc/gw/admin-keys.json',
      [ENV.adminListenHost]: '10.0.0.5',
      [ENV.plaintextBehindProxy]: 'true',
    };
    expect(() => loadConfig(behindProxy)).toThrow(ENV.adminAllowNonLoopback);
    expect(() => loadConfig({ ...behindProxy, [ENV.adminAllowNonLoopback]: 'false' })).toThrow(
      ENV.adminAllowNonLoopback
    );
    expect(() => loadConfig({ ...behindProxy, [ENV.adminAllowNonLoopback]: 'yes' })).toThrow(
      /true or false/
    );
    expect(loadConfig({ ...behindProxy, [ENV.adminAllowNonLoopback]: 'true' }).admin?.host).toBe(
      '10.0.0.5'
    );
    // The opt-in does not stand in for TLS or a declared proxy.
    expect(() =>
      loadConfig({
        ...GOOD,
        [ENV.adminKeysFile]: '/etc/gw/admin-keys.json',
        [ENV.adminListenHost]: '10.0.0.5',
        [ENV.adminAllowNonLoopback]: 'true',
      })
    ).toThrow(/no TLS is configured/);
  });

  it('reads the optional spool threshold', () => {
    expect(loadConfig({ ...GOOD, [ENV.spoolThresholdBytes]: '1024' }).spoolThresholdBytes).toBe(
      1024
    );
  });
});

describe('startGateway refuses to start on a bad secret or directory', () => {
  it('without the master secret file', async () => {
    const rig = await startRig();
    try {
      await expect(startGateway(rig.config, { env: {}, sink: () => undefined })).rejects.toThrow(
        MasterSecretError
      );
    } finally {
      await rig.stop();
    }
  });

  it('with an upstream secret file that group or others can read', async () => {
    const rig = await startRig();
    try {
      await chmod(rig.config.upstream.secretFile, 0o644);
      await expect(
        startGateway(rig.config, { env: rig.env, sink: () => undefined })
      ).rejects.toThrow(/readable by group or others/);
    } finally {
      await rig.stop();
    }
  });

  it('with an empty upstream key id file', async () => {
    const rig = await startRig();
    try {
      await writeFile(rig.config.upstream.keyIdFile, '\n', { mode: 0o600 });
      await expect(
        startGateway(rig.config, { env: rig.env, sink: () => undefined })
      ).rejects.toThrow(/is empty/);
    } finally {
      await rig.stop();
    }
  });

  it('with a spool directory others can reach', async () => {
    const rig = await startRig();
    try {
      await chmod(rig.spoolDir, 0o755);
      await expect(
        startGateway(rig.config, { env: rig.env, sink: () => undefined })
      ).rejects.toThrow(/private to this process user/);
    } finally {
      await rig.stop();
    }
  });
});
