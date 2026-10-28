import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { PROFESSIONAL, resolveTierPolicy } = require('../../src/tier-policy.js');

describe('resolveTierPolicy', () => {
  it('refuses video and audio by default, with no config at all', () => {
    expect(resolveTierPolicy()).toEqual({ allowVideoAudio: false });
    expect(resolveTierPolicy(null)).toEqual({ allowVideoAudio: false });
  });

  it('refuses video and audio when only unrelated keys are present', () => {
    expect(resolveTierPolicy({ verdictSource: 'in-process-fake' }).allowVideoAudio).toBe(false);
  });

  it.each([
    undefined,
    null,
    '',
    ' ',
    'Professional',
    'PROFESSIONAL',
    ' professional',
    'professional ',
    'professional\n',
    'pro',
    'professionals',
    'entry',
    'demo',
    'hobbyist',
    'true',
    true,
    false,
    1,
    0,
    ['professional'],
    { toString: () => 'professional' },
  ])('treats tier %j as a refusing tier', (tier) => {
    expect(resolveTierPolicy({ tier }).allowVideoAudio).toBe(false);
  });

  it('allows video and audio only on the exact value', () => {
    expect(PROFESSIONAL).toBe('professional');
    expect(resolveTierPolicy({ tier: 'professional' })).toEqual({ allowVideoAudio: true });
  });
});
