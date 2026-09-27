import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { SafetyPolicy } = require('../../src/policy.js');

describe('SafetyPolicy.decide', () => {
  const policy = new SafetyPolicy();

  it('allows a no-known-match verdict', () => {
    expect(policy.decide({ classification: 'no-known-match' })).toBe('allow');
  });

  it('allows when there is no verdict at all', () => {
    expect(policy.decide(undefined)).toBe('allow');
  });

  it('refuses a csam verdict', () => {
    expect(policy.decide({ classification: 'csam' })).toBe('refuse');
  });

  it('refuses a harmful-abusive-material verdict', () => {
    expect(policy.decide({ classification: 'harmful-abusive-material' })).toBe('refuse');
  });

  it('refuses the test classification too, since that is the route the control is proven through', () => {
    expect(policy.decide({ classification: 'test' })).toBe('refuse');
  });

  it('holds on an unavailable verdict', () => {
    expect(policy.decide({ classification: 'unavailable' })).toBe('hold');
  });
});
