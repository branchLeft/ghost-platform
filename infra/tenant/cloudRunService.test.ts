import { describe, it, expect } from 'vitest';
import { mailEnvs, type CloudRunServiceArgs } from './cloudRunService';
import type * as gcp from '@pulumi/gcp';

const fakeSecret = {
  secretId: 'ghost-tenant-blog-mail-password',
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
