import { describe, expect, it } from 'vitest';

import { assertDemosProject, checkDemosProject } from './projectGuard';

const OWN = 'project-marker-demos';

describe('assertDemosProject', () => {
  it('passes the empty demos project before its first apply', () => {
    expect(() => assertDemosProject([], [OWN])).not.toThrow();
  });

  it('passes the demos project after its first apply', () => {
    expect(() => assertDemosProject(['demo1'], [OWN, 'demo1'])).not.toThrow();
  });

  it.each(['tenants', 'dns', 'backup', 'demo-dns'])(
    'refuses the empty %s project, which has the same zero-server shape',
    (project) => {
      expect(() => assertDemosProject([], [`project-marker-${project}`])).toThrow(
        /another project, not demos: it can see project-marker-/
      );
    }
  );

  it('refuses a project with no marker at all', () => {
    expect(() => assertDemosProject([], [])).toThrow(
      /cannot see the firewall project-marker-demos/
    );
  });

  it.each([
    ['mx1', 'mail'],
    ['edge1', 'org'],
    ['ops1', 'org'],
    ['app-t1', 'tenants'],
  ])('refuses a token that can see %s (%s), even beside the demos marker', (server) => {
    expect(() => assertDemosProject([server], [OWN])).toThrow(
      new RegExp(`it can see ${server}\\.`)
    );
  });

  it('refuses a stray copy of the demos marker in another project', () => {
    expect(() => assertDemosProject([], [OWN, 'project-marker-org'])).toThrow(/project-marker-org/);
  });

  it('names only what it matched, never the rest of the inventory', () => {
    expect(() => assertDemosProject(['mx1', 'secret-host'], [OWN, 'private-fw'])).toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/secret-host|private-fw/) })
    );
  });
});

describe('checkDemosProject', () => {
  it('reads the names out of both data-source shapes', () => {
    expect(
      checkDemosProject({ servers: [{ name: 'demo1' }] }, { firewalls: [{ name: OWN }] })
    ).toBe(true);
    expect(() =>
      checkDemosProject({ servers: [{ name: 'edge1' }] }, { firewalls: [{ name: OWN }] })
    ).toThrow(/edge1/);
    expect(() =>
      checkDemosProject({ servers: [] }, { firewalls: [{ name: 'project-marker-org' }] })
    ).toThrow(/project-marker-org/);
  });
});
