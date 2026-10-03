import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { hostnameProblem, MAX_SLUG_LENGTH, validateConfig } from '../src/config.js';
import { HOSTNAMES, TWO_TENANTS } from './fakes.js';

const valid = { hostnames: HOSTNAMES, tenants: TWO_TENANTS };

function problemsOf(raw: unknown): readonly string[] {
  try {
    validateConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('validateConfig', () => {
  it('accepts a well-formed list and an empty one', () => {
    expect(validateConfig(valid).tenants).toHaveLength(2);
    expect(validateConfig({ hostnames: HOSTNAMES, tenants: [] }).tenants).toEqual([]);
  });

  it.each([null, 'x', 3, [], undefined])('refuses a non-object document %j', (raw) => {
    expect(problemsOf(raw)).toEqual(['configuration must be a JSON object']);
  });

  it('refuses a missing or mistyped hostnames block and tenants list', () => {
    expect(problemsOf({ tenants: [] })).toContain(
      'hostnames must be an object with console, portal and identity'
    );
    expect(problemsOf({ hostnames: HOSTNAMES })).toContain('tenants must be an array');
    expect(problemsOf({ hostnames: HOSTNAMES, tenants: {} })).toContain('tenants must be an array');
  });

  it.each([
    ['https://portal.example.test', 'scheme'],
    ['portal.example.test:8443', 'port'],
    ['*.example.test', 'wildcard'],
    ['Portal.example.test', 'upper case'],
    ['10.0.0.1', 'address'],
    ['localhost', 'one label'],
    ['portal.example.test/path', 'path'],
    ['-bad.example.test', 'leading hyphen'],
    ['', 'empty'],
    [42, 'number'],
  ])('refuses the hostname %j (%s)', (value, _why) => {
    const problems = problemsOf({ hostnames: { ...HOSTNAMES, portal: value }, tenants: [] });
    expect(problems.some((p) => p.startsWith('hostnames.portal'))).toBe(true);
  });

  it('refuses a hostname longer than a DNS name can be', () => {
    expect(hostnameProblem('h', `${'a'.repeat(250)}.com`)).toContain('253');
  });

  it('refuses any two applications sharing a hostname, naming both fields', () => {
    const problems = problemsOf({
      hostnames: { ...HOSTNAMES, portal: HOSTNAMES.console },
      tenants: [],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('hostnames.portal and hostnames.console');
    expect(
      problemsOf({ hostnames: { ...HOSTNAMES, identity: HOSTNAMES.portal }, tenants: [] })[0]
    ).toContain('hostnames.identity and hostnames.portal');
  });

  it('collects every problem rather than stopping at the first', () => {
    const problems = problemsOf({
      hostnames: { console: 'bad', portal: 'bad', identity: 'bad' },
      tenants: [{ slug: 'Bad' }],
    });
    expect(problems.length).toBeGreaterThan(3);
  });

  it.each(['Alpha', '1abc', 'a_b', '-a', 'a-', '', 3, undefined])('refuses the slug %j', (slug) => {
    const problems = problemsOf({ hostnames: HOSTNAMES, tenants: [{ slug, displayName: 'X' }] });
    expect(problems.some((p) => p.includes('tenants[0].slug'))).toBe(true);
  });

  it('refuses a slug past the cap, accepts one at it', () => {
    const at = 'a'.repeat(MAX_SLUG_LENGTH);
    expect(
      validateConfig({ hostnames: HOSTNAMES, tenants: [{ slug: at, displayName: 'X' }] }).tenants
    ).toHaveLength(1);
    expect(
      problemsOf({ hostnames: HOSTNAMES, tenants: [{ slug: `${at}a`, displayName: 'X' }] })[0]
    ).toContain('longer than');
  });

  it.each(['owner', 'branchleft-owner', 'console', 'portal', 'identity', 'admin'])(
    'refuses the reserved slug %s',
    (slug) => {
      expect(
        problemsOf({ hostnames: HOSTNAMES, tenants: [{ slug, displayName: 'X' }] })[0]
      ).toContain('reserved');
    }
  );

  it('refuses a repeated slug', () => {
    const tenants = [
      { slug: 'alpha', displayName: 'A' },
      { slug: 'alpha', displayName: 'B' },
    ];
    expect(problemsOf({ hostnames: HOSTNAMES, tenants })[0]).toContain('appears twice');
  });

  it.each([undefined, '', '   ', 7, 'x'.repeat(101)])(
    'refuses the display name %j',
    (displayName) => {
      const problems = problemsOf({
        hostnames: HOSTNAMES,
        tenants: [{ slug: 'alpha', displayName }],
      });
      expect(problems.some((p) => p.includes('displayName'))).toBe(true);
    }
  );

  it('refuses a tenant entry that is not an object', () => {
    expect(problemsOf({ hostnames: HOSTNAMES, tenants: ['alpha', null, []] })).toHaveLength(3);
  });

  it('does not reconcile from a partly valid list', () => {
    expect(() =>
      validateConfig({
        hostnames: HOSTNAMES,
        tenants: [TWO_TENANTS[0], { slug: 'Bad', displayName: 'X' }],
      })
    ).toThrow(ConfigError);
  });
});
