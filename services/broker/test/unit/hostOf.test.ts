import { describe, expect, it } from 'vitest';
import type { Instant } from '@branchleft/ghost-platform-render-core';
import { hostOf } from '../../src/hostOf.js';
import { demoDescriptor } from '../helpers/fixtures.js';

describe('hostOf', () => {
  it('builds sub.demoZone for an "ours" hostname', () => {
    const descriptor = demoDescriptor({
      hostname: { kind: 'ours', sub: 'k7m-vale-bright', gated: true },
    });
    expect(hostOf(descriptor, 'demo-domain.example.test')).toBe(
      'k7m-vale-bright.demo-domain.example.test'
    );
  });

  it('uses the fqdn as-is for a "theirs" hostname', () => {
    const descriptor = demoDescriptor({
      hostname: {
        kind: 'theirs',
        fqdn: 'blog.custom.example',
        verifiedAt: '2026-01-01T00:00:00.000Z' as Instant,
      },
    });
    expect(hostOf(descriptor, 'demo-domain.example.test')).toBe('blog.custom.example');
  });
});
