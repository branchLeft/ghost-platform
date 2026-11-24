/**
 * `mail.bulk`: a provider-neutral bulk-mail endpoint. Two things are pinned.
 * A descriptor with no `bulk` renders byte-for-byte what it rendered before
 * the field existed (the committed goldens), and one that names an endpoint
 * changes exactly the bulk keys and nothing else. See ../src/mail.md#bulk-endpoint.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FieldValidationError } from '../src/brand.js';
import type { BulkMailSpec, TenantDescriptor, TenantStackDescriptor } from '../src/descriptor.js';
import { SECRET_ENV_KEYS, tenantEnvironment } from '../src/environment.js';
import { MAIL_SPOOL_BASE_URL } from '../src/spool.js';
import { secretsEnvPath } from '../src/naming.js';
import { render } from '../src/render.js';
import { uploadLimits } from '../src/runtime.js';
import { TierMismatchError, validate, validateTenantStack } from '../src/validate.js';
import { TEST_ZONES, demoDescriptor, entryTenantDescriptor, tenantDescriptor } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = (name: string): string => readFileSync(join(here, 'golden', name), 'utf-8');

const BULK: BulkMailSpec = {
  endpoint: 'https://bulk.endpoint.example',
  domain: 'news.entry-co.example',
  credentialRef: 'GHOST_BULK_SUBMISSION_KEY',
};

function withBulk(descriptor: TenantDescriptor, bulk: unknown): TenantDescriptor {
  return { ...descriptor, mail: { ...descriptor.mail, bulk } } as unknown as TenantDescriptor;
}

function artefactsOf(descriptor: TenantDescriptor): Map<string, string> {
  const rendered = render(validate(descriptor, TEST_ZONES), TEST_ZONES);
  return new Map(rendered.map((artefact) => [artefact.path, artefact.content]));
}

function envOf(descriptor: TenantDescriptor): Record<string, string | number | boolean> {
  const checked = validate(descriptor, TEST_ZONES);
  return tenantEnvironment(checked, uploadLimits(), secretsEnvPath(checked.slug), TEST_ZONES);
}

function refusalOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a tenant with no bulk setting renders exactly as before (golden)', () => {
  const rendered = artefactsOf(entryTenantDescriptor());

  it.each(['compose.yml', 'secrets.env'])('%s matches the committed golden', (path) => {
    expect(rendered.get(path)).toBe(golden(`entry-tenant.${path}`));
  });

  it('still points the bulk keys at the host mail spool, under the spool key', () => {
    const env = envOf(entryTenantDescriptor());
    expect(env.bulkEmail__mailgun__baseUrl).toBe(MAIL_SPOOL_BASE_URL);
    expect(env.bulkEmail__mailgun__domain).toBe('blog.entry-co.example');
    expect(String(env.bulkEmail__mailgun__apiKey)).toContain(SECRET_ENV_KEYS.bulkEmailApiKey);
  });

  it('a spool tenant on the queue transport is unchanged too', () => {
    const env = envOf(tenantDescriptor());
    expect(env.bulkEmail__mailgun__baseUrl).toBe(MAIL_SPOOL_BASE_URL);
  });
});

describe('a tenant that names a bulk endpoint (golden)', () => {
  const descriptor = withBulk(entryTenantDescriptor(), BULK);
  const rendered = artefactsOf(descriptor);

  it.each(['compose.yml', 'secrets.env'])('%s matches the committed golden', (path) => {
    expect(rendered.get(path)).toBe(golden(`entry-tenant-bulk.${path}`));
  });

  it('renders the endpoint, the domain and a reference to the named key', () => {
    const env = envOf(descriptor);
    expect(env.bulkEmail__mailgun__baseUrl).toBe(BULK.endpoint);
    expect(env.bulkEmail__mailgun__domain).toBe(BULK.domain);
    expect(env.bulkEmail__mailgun__apiKey).toBe(
      `\${${BULK.credentialRef}:?set ${BULK.credentialRef} in /etc/branchleft/entry-co.env}`
    );
  });

  it('never renders a credential value, and the spool is not named', () => {
    const compose = rendered.get('compose.yml') ?? '';
    expect(compose).not.toContain(MAIL_SPOOL_BASE_URL);
    expect(compose).toContain(`\${${BULK.credentialRef}:?`);
  });

  it('changes only the bulk keys: every other compose line is identical', () => {
    const before = (artefactsOf(entryTenantDescriptor()).get('compose.yml') ?? '').split('\n');
    const after = (rendered.get('compose.yml') ?? '').split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed.every((line) => line.includes('bulkEmail__mailgun__'))).toBe(true);
    expect(changed.length).toBeGreaterThan(0);
    for (const key of [
      'mail__transport',
      'mail__options__host',
      'mail__options__auth__user',
      'mail__options__auth__pass',
      'mail__from',
    ]) {
      expect(after.filter((line) => line.includes(key))).toEqual(
        before.filter((line) => line.includes(key))
      );
    }
  });

  it('the secrets template names the credential key, not the spool key', () => {
    const secrets = rendered.get('secrets.env') ?? '';
    expect(secrets).toContain(`${BULK.credentialRef}=`);
    expect(secrets).not.toContain(`${SECRET_ENV_KEYS.bulkEmailApiKey}=`);
  });

  it('may name the default credential key with its own endpoint', () => {
    const named = withBulk(entryTenantDescriptor(), {
      ...BULK,
      credentialRef: SECRET_ENV_KEYS.bulkEmailApiKey,
    });
    expect(String(envOf(named).bulkEmail__mailgun__apiKey)).toContain(
      `${SECRET_ENV_KEYS.bulkEmailApiKey}:?`
    );
    expect(artefactsOf(named).get('secrets.env')).toContain(`${SECRET_ENV_KEYS.bulkEmailApiKey}=`);
  });
});

describe('validate() -- mail.bulk', () => {
  it('accepts a well-formed endpoint on a tenant with an SMTP transport', () => {
    expect(() => validate(withBulk(entryTenantDescriptor(), BULK), TEST_ZONES)).not.toThrow();
  });

  it('accepts an endpoint with a port', () => {
    const bulk = { ...BULK, endpoint: 'https://bulk.endpoint.example:8443' };
    expect(() => validate(withBulk(entryTenantDescriptor(), bulk), TEST_ZONES)).not.toThrow();
  });

  it('validateTenantStack accepts it on a stack descriptor', () => {
    const { ownerEmail: _ownerEmail, ...stack } = withBulk(entryTenantDescriptor(), BULK);
    expect(() => validateTenantStack(stack as TenantStackDescriptor, TEST_ZONES)).not.toThrow();
  });

  it.each([
    ['plain http', { ...BULK, endpoint: 'http://bulk.endpoint.example' }],
    ['a path', { ...BULK, endpoint: 'https://bulk.endpoint.example/v3' }],
    ['a trailing slash', { ...BULK, endpoint: 'https://bulk.endpoint.example/' }],
    ['userinfo', { ...BULK, endpoint: 'https://user:pass@bulk.endpoint.example' }],
    ['a query', { ...BULK, endpoint: 'https://bulk.endpoint.example?x=1' }],
    ['a fragment', { ...BULK, endpoint: 'https://bulk.endpoint.example#x' }],
    ['an upper-case host', { ...BULK, endpoint: 'https://BULK.endpoint.example' }],
    ['not a URL', { ...BULK, endpoint: 'bulk.endpoint.example' }],
    ['an empty endpoint', { ...BULK, endpoint: '' }],
  ])('refuses an endpoint with %s', (_label, bulk) => {
    const error = refusalOf(() => validate(withBulk(entryTenantDescriptor(), bulk), TEST_ZONES));
    expect(error).toBeInstanceOf(FieldValidationError);
    expect((error as FieldValidationError).message).toContain('mail.bulk.endpoint');
  });

  it.each([
    ['empty', ''],
    ['a slash', 'a/b'],
    ['a space', 'a b'],
    ['a leading dot', '.example'],
    ['a dollar sign', 'a$b'],
    ['too long', 'a'.repeat(254)],
  ])('refuses a domain that is %s', (_label, domain) => {
    const error = refusalOf(() =>
      validate(withBulk(entryTenantDescriptor(), { ...BULK, domain }), TEST_ZONES)
    );
    expect(error).toBeInstanceOf(FieldValidationError);
    expect((error as FieldValidationError).message).toContain('mail.bulk.domain');
  });

  it.each([
    ['lower case', 'ghost_bulk_key'],
    ['another family', 'GHOST_MAIL_PASSWORD'],
    ['the database key', 'GHOST_DB_PASSWORD'],
    ['a bare prefix', 'GHOST_BULK_'],
    ['an interpolation', 'GHOST_BULK_${X}'],
    ['a space', 'GHOST_BULK_A B'],
    ['too long', `GHOST_BULK_${'A'.repeat(49)}`],
  ])('refuses a credential reference that is %s', (_label, credentialRef) => {
    const error = refusalOf(() =>
      validate(withBulk(entryTenantDescriptor(), { ...BULK, credentialRef }), TEST_ZONES)
    );
    expect(error).toBeInstanceOf(FieldValidationError);
    expect((error as FieldValidationError).message).toContain('mail.bulk.credentialRef');
  });

  it.each([
    ['a string', 'https://bulk.endpoint.example'],
    ['null', null],
    ['an array', []],
    ['an object missing the endpoint', { domain: 'a', credentialRef: 'GHOST_BULK_A' }],
    ['an object with a stray key', { ...BULK, apiKey: 'secret' }],
  ])('refuses a bulk that is %s', (_label, bulk) => {
    const error = refusalOf(() => validate(withBulk(entryTenantDescriptor(), bulk), TEST_ZONES));
    expect(error).toBeInstanceOf(FieldValidationError);
  });

  it('refuses it on a demo', () => {
    const error = refusalOf(() => validate(withBulk(demoDescriptor(), BULK), TEST_ZONES));
    expect(error).toBeInstanceOf(TierMismatchError);
  });

  it('refuses it with mail off', () => {
    const base = entryTenantDescriptor();
    const off = { ...base, mail: { ...base.mail, enabled: false, bulk: BULK } };
    const error = refusalOf(() => validate(off, TEST_ZONES));
    expect(error).toBeInstanceOf(FieldValidationError);
    expect((error as FieldValidationError).message).toContain('mail.enabled');
  });

  it('refuses it on the queue transport', () => {
    const error = refusalOf(() => validate(withBulk(tenantDescriptor(), BULK), TEST_ZONES));
    expect(error).toBeInstanceOf(FieldValidationError);
    expect((error as FieldValidationError).message).toContain('transport.kind');
  });
});
