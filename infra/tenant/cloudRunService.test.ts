import { describe, it, expect } from 'vitest';
import { mailEnvs, bulkEmailEnvs, type CloudRunServiceArgs } from './cloudRunService';
import type * as gcp from '@pulumi/gcp';

const fakeSecret = {
  secretId: 'ghost-tenant-blog-mail-password',
} as unknown as gcp.secretmanager.Secret;

const fakeBulkEmailSecret = {
  secretId: 'ghost-tenant-blog-bulk-email-api-key',
} as unknown as gcp.secretmanager.Secret;

describe('mailEnvs', () => {
  it('emits nothing when mail is not configured', () => {
    expect(mailEnvs(undefined)).toEqual([]);
  });

  it('emits the doc 13 §2.3 SMTP shape when mail is configured', () => {
    const mail: NonNullable<CloudRunServiceArgs['mail']> = {
      host: 'mx1.branchleft.co.uk',
      port: '587',
      user: 'blog@example.org',
      from: 'blog@example.org',
      passwordSecret: fakeSecret,
    };

    expect(mailEnvs(mail)).toEqual([
      { name: 'mail__transport', value: 'SMTP' },
      { name: 'mail__options__host', value: 'mx1.branchleft.co.uk' },
      { name: 'mail__options__port', value: '587' },
      { name: 'mail__options__secure', value: 'false' },
      { name: 'mail__options__auth__user', value: 'blog@example.org' },
      {
        name: 'mail__options__auth__pass',
        valueSource: {
          secretKeyRef: { secret: fakeSecret.secretId, version: 'latest' },
        },
      },
      { name: 'mail__from', value: 'blog@example.org' },
    ]);
  });

  it('never puts the password in a plain env, only behind secretKeyRef', () => {
    const mail: NonNullable<CloudRunServiceArgs['mail']> = {
      host: 'mx1.branchleft.co.uk',
      port: '587',
      user: 'blog@example.org',
      from: 'blog@example.org',
      passwordSecret: fakeSecret,
    };

    const passEnv = mailEnvs(mail).find((env) => env.name === 'mail__options__auth__pass');
    expect(passEnv).not.toHaveProperty('value');
    expect(passEnv).toHaveProperty('valueSource.secretKeyRef.secret', fakeSecret.secretId);
  });
});

describe('bulkEmailEnvs', () => {
  it('emits nothing when bulkEmail is not configured', () => {
    expect(bulkEmailEnvs(undefined)).toEqual([]);
  });

  it('emits exactly the three bulkEmail__mailgun__* envs when configured', () => {
    const bulkEmail: NonNullable<CloudRunServiceArgs['bulkEmail']> = {
      baseUrl: 'https://mailgun-shim.branchleft.co.uk',
      domain: 'blog.branchleft.co.uk',
      apiKeySecret: fakeBulkEmailSecret,
    };

    expect(bulkEmailEnvs(bulkEmail)).toEqual([
      { name: 'bulkEmail__mailgun__baseUrl', value: 'https://mailgun-shim.branchleft.co.uk' },
      { name: 'bulkEmail__mailgun__domain', value: 'blog.branchleft.co.uk' },
      {
        name: 'bulkEmail__mailgun__apiKey',
        valueSource: {
          secretKeyRef: { secret: fakeBulkEmailSecret.secretId, version: 'latest' },
        },
      },
    ]);
  });

  it('never puts the apiKey in a plain env, only behind secretKeyRef', () => {
    const bulkEmail: NonNullable<CloudRunServiceArgs['bulkEmail']> = {
      baseUrl: 'https://mailgun-shim.branchleft.co.uk',
      domain: 'blog.branchleft.co.uk',
      apiKeySecret: fakeBulkEmailSecret,
    };

    const apiKeyEnv = bulkEmailEnvs(bulkEmail).find(
      (env) => env.name === 'bulkEmail__mailgun__apiKey'
    );
    expect(apiKeyEnv).not.toHaveProperty('value');
    expect(apiKeyEnv).toHaveProperty(
      'valueSource.secretKeyRef.secret',
      fakeBulkEmailSecret.secretId
    );
  });
});

describe('mailEnvs + bulkEmailEnvs combined', () => {
  it('absent bulkEmail leaves the env list identical to before bulkEmail existed', () => {
    // Regression guard for the "no bulkEmail block ⇒ unchanged output" claim:
    // spreading both helpers with only bulkEmail absent must equal mailEnvs alone.
    const mail: NonNullable<CloudRunServiceArgs['mail']> = {
      host: 'mx1.branchleft.co.uk',
      port: '587',
      user: 'blog@example.org',
      from: 'blog@example.org',
      passwordSecret: fakeSecret,
    };

    expect([...mailEnvs(mail), ...bulkEmailEnvs(undefined)]).toEqual(mailEnvs(mail));
    expect([...mailEnvs(undefined), ...bulkEmailEnvs(undefined)]).toEqual([]);
  });
});
