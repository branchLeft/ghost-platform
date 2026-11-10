import { chmod, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV, PREAUTH_BODY_CAP_MIB, loadConfig } from '../src/config.js';
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
    expect(config.maxBodyBytes).toBe(PREAUTH_BODY_CAP_MIB * MIB);
    expect(config.admin).toBeUndefined();
    expect(config.tls).toBeUndefined();
  });

  it('caps the pre-authentication body at the largest ceiling a tenant may hold', () => {
    expect(PREAUTH_BODY_CAP_MIB).toBe(MAX_UPLOAD_CEILING_MIB);
    expect(() =>
      loadConfig({ ...GOOD, [ENV.maxBodyMib]: String(PREAUTH_BODY_CAP_MIB + 1) })
    ).toThrow(/between 1 and/);
    expect(loadConfig({ ...GOOD, [ENV.maxBodyMib]: '2' }).maxBodyBytes).toBe(2 * MIB);
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
