import { describe, expect, it } from 'vitest';
import type { Slug } from '../src/brand.js';
import {
  adaptersVolumeName,
  composeUnitName,
  contentVolumeName,
  databaseAndUserName,
  imageEnvPath,
  secretsEnvPath,
  sqlIdentifier,
  stackDirectory,
  stackName,
} from '../src/naming.js';

const slug = 'my-tenant' as Slug;

describe('naming.ts', () => {
  it('sqlIdentifier replaces every hyphen with an underscore', () => {
    expect(sqlIdentifier(slug)).toBe('my_tenant');
  });

  it('databaseAndUserName prefixes the sql identifier', () => {
    expect(databaseAndUserName(slug)).toBe('ghost_my_tenant');
  });

  it('stackName is the slug itself', () => {
    expect(stackName(slug)).toBe('my-tenant');
  });

  it('stackDirectory is under /opt/branchleft', () => {
    expect(stackDirectory(slug)).toBe('/opt/branchleft/my-tenant');
  });

  it('composeUnitName is the systemd instance name', () => {
    expect(composeUnitName(slug)).toBe('branchleft-compose@my-tenant.service');
  });

  it('secretsEnvPath and imageEnvPath are distinct files under /etc/branchleft', () => {
    expect(secretsEnvPath(slug)).toBe('/etc/branchleft/my-tenant.env');
    expect(imageEnvPath(slug)).toBe('/etc/branchleft/my-tenant.image.env');
    expect(secretsEnvPath(slug)).not.toBe(imageEnvPath(slug));
  });

  it('content and adapters volumes are distinct, derived from the slug alone', () => {
    expect(contentVolumeName(slug)).toBe('ghost-my-tenant-content');
    expect(adaptersVolumeName(slug)).toBe('ghost-my-tenant-adapters');
    expect(contentVolumeName(slug)).not.toBe(adaptersVolumeName(slug));
  });
});
