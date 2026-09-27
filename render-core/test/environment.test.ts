/**
 * `tenantEnvironment()`'s break-glass keys, in isolation from the rest of
 * `render()`'s seven artefacts (those are pinned by `render.test.ts`'s
 * golden files, none of which carry `breakGlass.kind = "enabled"` — see
 * `fixtures.ts`).
 */
import { describe, expect, it } from 'vitest';
import { tenantEnvironment } from '../src/environment.js';
import { uploadLimits } from '../src/runtime.js';
import { secretsEnvPath } from '../src/naming.js';
import { breakGlassEnabled, tenantDescriptor } from './fixtures.js';

const LIMITS = uploadLimits();

function env(descriptor: ReturnType<typeof tenantDescriptor>) {
  return tenantEnvironment(descriptor, LIMITS, secretsEnvPath(descriptor.slug));
}

describe('tenantEnvironment() — breakGlass', () => {
  it('renders no adapters__sso__* key at all when breakGlass is disabled', () => {
    const rendered = env(tenantDescriptor());
    for (const key of Object.keys(rendered)) {
      expect(key.startsWith('adapters__sso__')).toBe(false);
    }
  });

  it('renders the active flag and all three configured values when enabled', () => {
    const descriptor = { ...tenantDescriptor(), breakGlass: breakGlassEnabled('acme') };
    const rendered = env(descriptor);
    expect(rendered.adapters__sso__active).toBe('BreakGlassSSO');
    expect(rendered.adapters__sso__BreakGlassSSO__publicKey).toBe(
      breakGlassEnabled('acme').publicKey
    );
    expect(rendered.adapters__sso__BreakGlassSSO__tenant).toBe('acme');
    expect(rendered.adapters__sso__BreakGlassSSO__supportIdentity).toBe('support@branchleft.co.uk');
  });

  it('escapes a literal "$" in a break-glass value the same way every other env value is escaped', () => {
    const descriptor = {
      ...tenantDescriptor(),
      breakGlass: { ...breakGlassEnabled('acme'), publicKey: 'abc$def' },
    };
    const rendered = env(descriptor);
    expect(rendered.adapters__sso__BreakGlassSSO__publicKey).toBe('abc$$def');
  });
});
