import { describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  buildDockerStopArgs,
  type TenantColourSpec,
} from '../../src/containerRunner.js';

describe('buildDockerRunArgs', () => {
  const spec: TenantColourSpec = {
    containerName: 'tenant-1-export-123',
    image: 'ghost-platform:ci',
    loopbackPort: 4400,
    env: { database__client: 'sqlite3' },
    volumes: [{ volume: 'ghost-tenant-1-content', mountPath: '/var/lib/ghost/content' }],
  };

  it('publishes only on 127.0.0.1 -- LLD-8 §08b\'s "no route pointed at it"', () => {
    const args = buildDockerRunArgs(spec);
    const idx = args.indexOf('-p');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('127.0.0.1:4400:2368');
    // Never a bare port mapping and never 0.0.0.0 -- both would publish on
    // every interface, which is exactly the "route pointed at it" this
    // colour must not have.
    expect(args).not.toContain('4400:2368');
    expect(args.join(' ')).not.toContain('0.0.0.0');
  });

  it("mounts the tenant's own data volume, never a fresh one", () => {
    const args = buildDockerRunArgs(spec);
    const idx = args.indexOf('--mount');
    expect(args[idx + 1]).toBe('type=volume,src=ghost-tenant-1-content,dst=/var/lib/ghost/content');
  });

  it('carries the container name so stop() can target exactly this run', () => {
    const args = buildDockerRunArgs(spec);
    const idx = args.indexOf('--name');
    expect(args[idx + 1]).toBe('tenant-1-export-123');
  });

  it("never runs through a shell -- every value is its own argv element, matching wrapper.ts's own sudoers-boundary reasoning", () => {
    const args = buildDockerRunArgs(spec);
    for (const arg of args) {
      expect(arg).not.toMatch(/[;&|`$]/);
    }
  });
});

describe('buildDockerStopArgs', () => {
  it('force-removes exactly the named container', () => {
    expect(buildDockerStopArgs('tenant-1-export-123')).toEqual(['rm', '-f', 'tenant-1-export-123']);
  });
});
