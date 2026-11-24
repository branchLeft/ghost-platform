import { describe, expect, it } from 'vitest';
import { renderFederation } from '../src/tenant/federationSettings.js';

describe('the federation settings page', () => {
  it('shows the switch to a real tenant, off by default, and posts it to the save route', () => {
    const html = renderFederation('REAL', false);
    expect(html).toContain('<form method="post" action="/federation/save">');
    expect(html).toContain('name="federation.enabled" value="1"');
    expect(html).not.toContain(' checked');
    expect(html).toContain('FEDERATION_CURRENTLY_OFF');
  });

  it('shows a real tenant its switch on when it is on', () => {
    const html = renderFederation('REAL', true);
    expect(html).toContain(' checked');
    expect(html).toContain('FEDERATION_CURRENTLY_ON');
  });

  it('offers a demo slot no switch and no form', () => {
    const html = renderFederation('DEMO', false);
    expect(html).toContain('DEMO_NO_FEDERATION_SETTING');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('federation.enabled');
  });

  it('refuses to render anything for a kind that is not exact', () => {
    expect(() => renderFederation('demo' as 'DEMO', true)).toThrow();
  });
});
