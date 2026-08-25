import { describe, expect, it } from 'vitest';
import {
  SECRET_ENV_KEYS,
  tenantEnvironment,
  tenantSecretsEnvFile,
  type TenantEnvironmentArgs,
} from './environment';
import { uploadLimits } from './runtime';

const SECRETS_PATH = '/etc/branchleft/blog.env';

function envArgs(overrides: Partial<TenantEnvironmentArgs> = {}): TenantEnvironmentArgs {
  return {
    siteUrl: 'https://blog.example.org',
    database: { host: '10.20.1.20', port: 3306, name: 'ghost_blog', user: 'ghost_blog' },
    media: {
      endpoint: 'https://hel1.your-objectstorage.com',
      region: 'hel1',
      bucket: 'branchleft-media-blog',
      publicBaseUrl: 'https://hel1.your-objectstorage.com/branchleft-media-blog',
    },
    limits: uploadLimits(128, 512),
    ...overrides,
  };
}

describe('tenantEnvironment', () => {
  const env = tenantEnvironment(envArgs(), SECRETS_PATH);

  it('never inlines a secret', () => {
    for (const key of Object.values(SECRET_ENV_KEYS)) {
      const referencing = Object.values(env).filter(
        (value) => typeof value === 'string' && value.includes(key)
      );
      for (const value of referencing) {
        // `${VAR:?message}` — a missing secret fails the stack's start rather
        // than booting Ghost with an empty credential.
        expect(value).toMatch(new RegExp(`^\\$\\{${key}:\\?.*\\}$`));
      }
    }
    expect(env.database__connection__password).toContain(SECRET_ENV_KEYS.databasePassword);
    expect(env.storage__S3Storage__secretAccessKey).toContain(SECRET_ENV_KEYS.s3SecretAccessKey);
  });

  it('names the secrets file in the failure message, not just the variable', () => {
    expect(String(env.database__connection__password)).toContain(SECRETS_PATH);
  });

  // db1 runs `require_secure_transport = ON`, so an unencrypted connection is
  // refused outright; mysql2 only negotiates TLS when an `ssl` object exists
  // at all, which this key's presence supplies.
  it('enables TLS to db1 against its self-signed certificate', () => {
    expect(env.database__connection__ssl__rejectUnauthorized).toBe(false);
    expect(env.database__connection__host).toBe('10.20.1.20');
  });

  // nconf parses env values (`parseValues: true`), so these arrive as real
  // booleans and numbers rather than truthy strings.
  it('emits booleans and byte counts in their parsed forms', () => {
    expect(env.security__allowWebhookInternalIPs).toBe(false);
    expect(env.privacy__useUpdateCheck).toBe(false);
    expect(env.storage__S3Storage__forcePathStyle).toBe(true);
    expect(typeof env.theme__uploadLimits__compressedBytes).toBe('number');
  });

  it('states allowWebhookInternalIPs explicitly rather than trusting the default', () => {
    // The default is already false; stating it means a Ghost release that
    // changes it shows up as a diff here rather than as an open path from a
    // tenant's own integrations UI to the estate's private network.
    expect('security__allowWebhookInternalIPs' in env).toBe(true);
  });

  it('carries the theme ceilings derived from the same input as the tmpfs', () => {
    const limits = uploadLimits(128, 512);
    expect(env.theme__uploadLimits__compressedBytes).toBe(limits.themeCompressedBytes);
    expect(env.theme__uploadLimits__entryUncompressedBytes).toBe(
      limits.themeEntryUncompressedBytes
    );
    expect(env.theme__uploadLimits__totalUncompressedBytes).toBe(
      limits.themeTotalUncompressedBytes
    );
  });

  it('emits no mail or bulk-email keys when neither is configured', () => {
    for (const key of Object.keys(env)) {
      expect(key.startsWith('mail__')).toBe(false);
      expect(key.startsWith('bulkEmail__')).toBe(false);
    }
  });

  it('emits the full mail set when mail is configured', () => {
    const withMail = tenantEnvironment(
      envArgs({
        mail: { host: 'mx1.example.org', port: 587, user: 'blog@example.org', from: 'a@b.c' },
      }),
      SECRETS_PATH
    );
    expect(withMail.mail__transport).toBe('SMTP');
    expect(withMail.mail__options__port).toBe(587);
    expect(withMail.mail__options__secure).toBe(false);
    expect(withMail.mail__options__auth__pass).toContain(SECRET_ENV_KEYS.mailPassword);
  });

  // Ghost treats the mere presence of the `bulkEmail.mailgun` object as
  // "configured" and crashes with `new URL(undefined)` on a partial set.
  it('emits all three bulk-email keys or none', () => {
    const withBulk = tenantEnvironment(
      envArgs({ bulkEmail: { baseUrl: 'https://shim.example.org/v3', domain: 'blog' } }),
      SECRETS_PATH
    );
    const keys = Object.keys(withBulk).filter((key) => key.startsWith('bulkEmail__'));
    expect(keys.sort()).toEqual([
      'bulkEmail__mailgun__apiKey',
      'bulkEmail__mailgun__baseUrl',
      'bulkEmail__mailgun__domain',
    ]);
  });

  // The entrypoint refuses to start without these five; a tenant rendered
  // without one boots into a fail-closed error rather than silently onto
  // local disk, but the refusal belongs here where it is a diff.
  it('satisfies the image entrypoint storage guard', () => {
    for (const key of [
      'storage__active',
      'storage__S3Storage__bucket',
      'storage__S3Storage__staticFileURLPrefix',
      'storage__S3Storage__cdnUrl',
      'storage__S3Storage__multipartUploadThresholdBytes',
      'storage__S3Storage__multipartChunkSizeBytes',
    ]) {
      expect(env[key]).toBeTruthy();
    }
    expect(env.storage__active).toBe('S3Storage');
  });

  // Bucket-per-tenant, so there is no prefix to set. Ghost's S3Storage takes
  // `tenantPrefix` as optional and stores keys unprefixed without it; setting
  // it would put a redundant segment into every published media URL.
  it('sets no tenant prefix, and points at this tenant own bucket', () => {
    expect(env).not.toHaveProperty('storage__S3Storage__tenantPrefix');
    expect(env.storage__S3Storage__bucket).toBe('branchleft-media-blog');
    expect(env.storage__S3Storage__cdnUrl).toBe(
      'https://hel1.your-objectstorage.com/branchleft-media-blog'
    );
  });
});

describe('tenantSecretsEnvFile', () => {
  it('renders exactly the keys the Compose file references', () => {
    const file = tenantSecretsEnvFile('blog', {
      databasePassword: 'dbpw',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'sk',
    });
    expect(file).toContain(`${SECRET_ENV_KEYS.databasePassword}=dbpw`);
    expect(file).toContain(`${SECRET_ENV_KEYS.s3AccessKeyId}=akid`);
    expect(file).toContain(`${SECRET_ENV_KEYS.s3SecretAccessKey}=sk`);
    expect(file).not.toContain(SECRET_ENV_KEYS.mailPassword);
    expect(file).not.toContain(SECRET_ENV_KEYS.bulkEmailApiKey);
    expect(file.endsWith('\n')).toBe(true);
  });

  it('adds the optional credentials only when supplied', () => {
    const file = tenantSecretsEnvFile('blog', {
      databasePassword: 'dbpw',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'sk',
      mailPassword: 'mp',
      bulkEmailApiKey: 'bk',
    });
    expect(file).toContain(`${SECRET_ENV_KEYS.mailPassword}=mp`);
    expect(file).toContain(`${SECRET_ENV_KEYS.bulkEmailApiKey}=bk`);
  });

  // systemd parses this file line by line, so a value carrying a newline does
  // not produce a malformed variable — it produces an extra, well-formed one.
  // A credential arriving with a trailing line is a way to set any other
  // variable in the container's environment, and nothing downstream reports it.
  it.each(['databasePassword', 's3AccessKeyId', 's3SecretAccessKey'])(
    'refuses a control character in %s',
    (field) => {
      const secrets = {
        databasePassword: 'dbpw',
        s3AccessKeyId: 'akid',
        s3SecretAccessKey: 'sk',
        [field]: 'value\nGHOST_DB_PASSWORD=attacker',
      };
      expect(() => tenantSecretsEnvFile('blog', secrets)).toThrow(/control character/);
    }
  );

  it('refuses a control character in an optional credential too', () => {
    expect(() =>
      tenantSecretsEnvFile('blog', {
        databasePassword: 'dbpw',
        s3AccessKeyId: 'akid',
        s3SecretAccessKey: 'sk',
        mailPassword: 'mp\nGHOST_S3_SECRET_ACCESS_KEY=attacker',
      })
    ).toThrow(/control character/);
  });

  // systemd's EnvironmentFile carries quotes into the value, so a quoted
  // password would arrive at Ghost with the quotes attached.
  it('emits values unquoted', () => {
    const file = tenantSecretsEnvFile('blog', {
      databasePassword: 'dbpw',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'sk',
    });
    expect(file).not.toContain('="');
    expect(file).not.toContain("='");
  });
});
