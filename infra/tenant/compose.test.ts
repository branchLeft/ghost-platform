import { describe, expect, it } from 'vitest';
import { assertRuntimePosture, renderComposeStack, type ComposeStackArgs } from './compose';
import { DEFAULT_RESOURCE_CAPS, uploadLimits } from './runtime';
import type { YamlValue } from './yaml';

const APP_HOST = '10.20.1.100';

function args(overrides: Partial<ComposeStackArgs> = {}): ComposeStackArgs {
  return {
    slug: 'blog',
    uid: 30001,
    appHostPrivateIp: APP_HOST,
    hostPort: 2368,
    limits: uploadLimits(128, 512),
    caps: DEFAULT_RESOURCE_CAPS,
    environment: { url: 'https://blog.example.org' },
    ...overrides,
  };
}

/** A minimal document that satisfies the posture, so each negative test can
 * break exactly one thing and nothing else. */
function compliantService(): Record<string, YamlValue> {
  return {
    image: '${IMAGE}',
    user: '30001:30001',
    init: true,
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    pids_limit: 256,
    mem_limit: '640m',
    memswap_limit: '640m',
    cpus: '1.0',
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    ports: [`${APP_HOST}:2368:2368`],
    volumes: ['ghost-blog-content:/var/lib/ghost/content'],
  };
}

function documentWith(service: Record<string, YamlValue>): Record<string, YamlValue> {
  return { name: 'blog', services: { ghost: service } };
}

describe('renderComposeStack', () => {
  const rendered = renderComposeStack(args());

  it('names the project for the tenant, which is the systemd instance name', () => {
    expect(rendered).toContain("name: 'blog'");
  });

  it('runs as the tenant UID rather than the image default', () => {
    expect(rendered).toContain("user: '30001:30001'");
  });

  it('carries the whole floor, with no per-tenant opt-out', () => {
    expect(rendered).toContain('read_only: true');
    expect(rendered).toContain('init: true');
    expect(rendered).toContain("- 'ALL'");
    expect(rendered).toContain("- 'no-new-privileges:true'");
    expect(rendered).toContain('pids_limit: 256');
    expect(rendered).toContain("mem_limit: '640m'");
    expect(rendered).toContain("memswap_limit: '640m'");
    expect(rendered).toContain("cpus: '1.0'");
    expect(rendered).toContain('cpu_shares: 512');
    expect(rendered).toContain("max-size: '10m'");
    expect(rendered).toContain("max-file: '3'");
    expect(rendered).toContain('soft: 4096');
    expect(rendered).toContain('hard: 4096');
  });

  it('sizes the tmpfs from the upload ceiling and mounts it noexec', () => {
    expect(rendered).toContain("- '/tmp:rw,noexec,nosuid,nodev,size=128m'");
  });

  it('publishes only to the app host private address', () => {
    expect(rendered).toContain(`- '${APP_HOST}:2368:2368'`);
    expect(rendered).not.toContain('0.0.0.0');
  });

  it('mounts content/adapters read-only over the writable content volume', () => {
    expect(rendered).toContain("- 'ghost-blog-content:/var/lib/ghost/content'");
    expect(rendered).toContain("- 'ghost-blog-adapters:/var/lib/ghost/content/adapters:ro'");
  });

  // Docker re-applies the image path's ownership and mode when it first
  // populates a volume it created. Declaring the volumes external makes the
  // host-side provisioning step a precondition instead: a missing volume
  // fails the start loudly rather than producing a running container on a
  // world-writable volume.
  it('declares both volumes external', () => {
    expect(rendered).toContain('ghost-blog-content:\n    external: true');
    expect(rendered).toContain('ghost-blog-adapters:\n    external: true');
  });

  it('carries none of the forbidden runtime options', () => {
    for (const forbidden of [
      'privileged',
      'cap_add',
      'network_mode',
      'devices',
      'docker.sock',
      'seccomp=unconfined',
      'pid:',
      'userns_mode',
    ]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it('refuses a UID outside the reserved range before rendering anything', () => {
    // The rendered document would be perfectly valid Compose; the refusal is
    // this component's, not Docker's.
    expect(() => renderComposeStack(args({ uid: 0 }))).toThrow();
  });
});

describe('assertRuntimePosture — the negative space', () => {
  it('accepts a compliant service', () => {
    expect(() =>
      assertRuntimePosture(documentWith(compliantService()), { appHostPrivateIp: APP_HOST })
    ).not.toThrow();
  });

  it.each([
    ['privileged', { privileged: true }],
    ['cap_add', { cap_add: ['SYS_ADMIN'] }],
    ['devices', { devices: ['/dev/fuse'] }],
    ['network_mode', { network_mode: 'host' }],
    ['pid', { pid: 'host' }],
    ['ipc', { ipc: 'host' }],
    ['userns_mode', { userns_mode: 'host' }],
    ['cgroup_parent', { cgroup_parent: 'system.slice' }],
  ])('refuses %s', (key, extra) => {
    expect(() =>
      assertRuntimePosture(documentWith({ ...compliantService(), ...extra }), {
        appHostPrivateIp: APP_HOST,
      })
    ).toThrow(new RegExp(`must not set \`${key}\``));
  });

  it('refuses the Docker socket, which is not a partial grant', () => {
    expect(() =>
      assertRuntimePosture(
        documentWith({
          ...compliantService(),
          volumes: ['/var/run/docker.sock:/var/run/docker.sock'],
        }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/never a host path/);
  });

  it.each(['seccomp=unconfined', 'apparmor=unconfined', 'systempaths=unconfined'])(
    'refuses opting out of the shipped default %s',
    (opt) => {
      expect(() =>
        assertRuntimePosture(
          documentWith({
            ...compliantService(),
            security_opt: ['no-new-privileges:true', opt],
          }),
          { appHostPrivateIp: APP_HOST }
        )
      ).toThrow(/must not opt out of a shipped default/);
    }
  );

  it.each(['0.0.0.0:2368:2368', '2368:2368', '10.20.1.101:2368:2368', '127.0.0.1:2368:2368'])(
    'refuses the publish %s',
    (port) => {
      expect(() =>
        assertRuntimePosture(documentWith({ ...compliantService(), ports: [port] }), {
          appHostPrivateIp: APP_HOST,
        })
      ).toThrow(/must bind the app host's private address/);
    }
  );

  it('refuses any bind mount, not only the socket', () => {
    expect(() =>
      assertRuntimePosture(
        documentWith({ ...compliantService(), volumes: ['/etc/branchleft:/config:ro'] }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/never a host path/);
  });

  it.each([
    ['read_only', { read_only: false }, /must set `read_only: true`/],
    ['init', { init: false }, /must set `init: true`/],
    ['user', { user: 'node' }, /numeric per-tenant/],
    ['cap_drop', { cap_drop: ['NET_RAW'] }, /must set `cap_drop/],
    ['security_opt', { security_opt: [] }, /no-new-privileges/],
    ['pids_limit', { pids_limit: undefined }, /must set `pids_limit`/],
    ['cpus', { cpus: undefined }, /must set `cpus`/],
  ])('refuses a service missing %s', (_key, extra, pattern) => {
    const service = { ...compliantService(), ...extra } as Record<string, YamlValue>;
    for (const [k, v] of Object.entries(extra)) if (v === undefined) delete service[k];
    expect(() =>
      assertRuntimePosture(documentWith(service), { appHostPrivateIp: APP_HOST })
    ).toThrow(pattern);
  });

  // mem_limit without memswap_limit is not a bound at all: the container may
  // then use swap without limit.
  it('refuses mem_limit without a matching memswap_limit', () => {
    expect(() =>
      assertRuntimePosture(documentWith({ ...compliantService(), memswap_limit: '-1' }), {
        appHostPrivateIp: APP_HOST,
      })
    ).toThrow(/swap is unbounded/);
  });

  it('refuses unbounded json-file logging, which fills the shared host disk', () => {
    expect(() =>
      assertRuntimePosture(
        documentWith({ ...compliantService(), logging: { driver: 'json-file' } }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/max-size/);
  });
});
