import { describe, expect, it } from 'vitest';
import { CONFIRM_VALUE, TargetError, targetFromEnv } from '../src/target.ts';

const DEPLOYED = {
  ATTACK_BASE_URL: 'https://sites.example.test',
  ATTACK_CONFIRM: CONFIRM_VALUE,
  ATTACK_ROOT_DOMAIN: 'example.test',
  ATTACK_TENANT_A: 'victim',
  ATTACK_TENANT_B: 'attacker',
  ATTACK_PORTAL_URL: 'https://portal.example.test',
  ATTACK_ADMIN_A_EMAIL: 'a@example.test',
  ATTACK_ADMIN_A_PASSWORD: 'pw-a',
  ATTACK_ADMIN_B_EMAIL: 'b@example.test',
  ATTACK_ADMIN_B_PASSWORD: 'pw-b',
};

describe('the target parameters', () => {
  it('is the local rig with no base URL', () => {
    expect(targetFromEnv({})).toEqual({ kind: 'local' });
    expect(targetFromEnv({ ATTACK_BASE_URL: '' })).toEqual({ kind: 'local' });
  });

  it('reads a deployed target from the base URL and its companions', () => {
    const t = targetFromEnv(DEPLOYED);
    expect(t).toMatchObject({
      kind: 'deployed',
      scheme: 'https',
      sharedDomain: 'sites.example.test',
      rootDomain: 'example.test',
      tenantA: 'victim',
      portalOrigin: 'https://portal.example.test',
      psl: 'absent',
    });
  });

  it('requires the root domain and that the shared domain sits under it', () => {
    const { ATTACK_ROOT_DOMAIN: _omitted, ...rest } = DEPLOYED;
    expect(() => targetFromEnv(rest)).toThrow(/ATTACK_ROOT_DOMAIN is required/);
    expect(() => targetFromEnv({ ...DEPLOYED, ATTACK_ROOT_DOMAIN: 'elsewhere.test' })).toThrow(
      TargetError
    );
  });

  it('refuses a deployed target without the throwaway confirmation', () => {
    const { ATTACK_CONFIRM: _omitted, ...rest } = DEPLOYED;
    expect(() => targetFromEnv(rest)).toThrow(TargetError);
    expect(() => targetFromEnv({ ...rest, ATTACK_CONFIRM: 'yes' })).toThrow(/ATTACK_CONFIRM/);
  });

  it.each([
    ['a path', { ATTACK_BASE_URL: 'https://sites.example.test/x' }],
    ['a port', { ATTACK_BASE_URL: 'https://sites.example.test:8443' }],
    ['a login', { ATTACK_BASE_URL: 'https://u:p@sites.example.test' }],
    ['a non-http scheme', { ATTACK_BASE_URL: 'ftp://sites.example.test' }],
    ['the same tenant twice', { ATTACK_TENANT_B: 'victim' }],
    ['a tenant that is not a label', { ATTACK_TENANT_A: 'a.b' }],
    ['a portal outside the root domain', { ATTACK_PORTAL_URL: 'https://portal.elsewhere.test' }],
    ['an unknown list state', { ATTACK_PSL: 'maybe' }],
    ['a malformed digest', { ATTACK_IMAGE_DIGESTS: 'ghost@sha256:abc' }],
  ])('refuses %s', (_name, override) => {
    expect(() => targetFromEnv({ ...DEPLOYED, ...override })).toThrow(TargetError);
  });

  it('names the missing variable and never echoes a credential', () => {
    const { ATTACK_ADMIN_B_PASSWORD: _omitted, ...rest } = DEPLOYED;
    try {
      targetFromEnv(rest);
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('ATTACK_ADMIN_B_PASSWORD');
      expect(message).not.toContain('pw-a');
    }
  });

  it('accepts supplied image digests', () => {
    const digest = `ghcr.io/example/ghost@sha256:${'a'.repeat(64)}`;
    const t = targetFromEnv({ ...DEPLOYED, ATTACK_IMAGE_DIGESTS: digest, ATTACK_PSL: 'present' });
    expect(t).toMatchObject({ suppliedImages: [digest], psl: 'present' });
  });
});
