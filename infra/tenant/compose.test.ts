import { describe, expect, it } from 'vitest';
import { assertRuntimePosture, renderComposeStack, type ComposeStackArgs } from './compose';
import { DEFAULT_RESOURCE_CAPS, uploadLimits } from './runtime';
import type { YamlValue } from './yaml';

const APP_HOST = '10.20.1.100';
const URL = 'http://127.0.0.1:2368/';
const HEADER = 'X-Forwarded-Proto: https';

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
    healthcheck: { test: ['CMD', 'wget', '--header', HEADER, URL] },
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

  // Ghost 301s a request it does not consider secure to `https://<requested
  // host>`, so the unadorned probe this replaced asked for TLS on a plaintext
  // port and failed every interval on a tenant that was serving perfectly.
  // The header is what the edge proxy sends, so the probe now takes the same
  // path a real request does.
  it('probes over loopback with the header the edge proxy sends', () => {
    expect(rendered).toMatch(/- '--header'\n\s+- 'X-Forwarded-Proto: https'/);
    expect(rendered).toContain("- 'http://127.0.0.1:2368/'");
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

  it.each(['0.0.0.0', '', '46.225.95.167', '127.0.0.1', 'localhost'])(
    'refuses to render a stack published on %s',
    (address) => {
      expect(() => renderComposeStack(args({ appHostPrivateIp: address }))).toThrow();
    }
  );

  it('refuses to render a stack on a privileged host port', () => {
    expect(() => renderComposeStack(args({ hostPort: 22 }))).toThrow(/hostPort/);
  });

  // The posture check runs over the object, before serialisation, so it cannot
  // see a value that becomes document structure only once it is written out.
  // The refusal for that lives in the emitter; this asserts the two together
  // on the paths a tenant's own configuration reaches.
  it.each([
    ['siteUrl', { url: 'https://blog.example.org\n    cap_add:\n      - SYS_ADMIN' }],
    ['a media URL', { storage__S3Storage__cdnUrl: 'https://x/\n    privileged: true' }],
    ['a mail address', { mail__from: 'a@b.c\n    network_mode: host' }],
  ])('refuses to render a config value that would inject Compose keys via %s', (_name, extra) => {
    expect(() =>
      renderComposeStack(args({ environment: { url: 'https://blog.example.org', ...extra } }))
    ).toThrow(/control character/);
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
      ).toThrow(/<app-host-private-ip>:<host-port>:<container-port>/);
    }
  );

  // The check used to compare each rendered port against the same unvalidated
  // input that produced it, so `0.0.0.0` passed a `startsWith` against itself.
  // A check whose expectation comes from its subject cannot fail, so the
  // address is now validated on its own terms first.
  it.each(['0.0.0.0', '', '46.225.95.167', 'localhost'])(
    'refuses %s as the app host address rather than validating it against itself',
    (address) => {
      expect(() =>
        assertRuntimePosture(
          documentWith({ ...compliantService(), ports: [`${address}:2368:2368`] }),
          {
            appHostPrivateIp: address,
          }
        )
      ).toThrow();
    }
  );

  // A two-part publish binds every interface — the same outcome as `0.0.0.0`
  // and harder to notice in a diff.
  it('refuses a two-part publish even when the host port looks right', () => {
    expect(() =>
      assertRuntimePosture(documentWith({ ...compliantService(), ports: ['8080:2368'] }), {
        appHostPrivateIp: APP_HOST,
      })
    ).toThrow(/<app-host-private-ip>/);
  });

  it('refuses a privileged host port on a host that already runs SSH', () => {
    expect(() =>
      assertRuntimePosture(
        documentWith({ ...compliantService(), ports: [`${APP_HOST}:22:2368`] }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/hostPort/);
  });

  // The failure this rejects shipped and reached a host: a probe Ghost
  // answers with a 301 makes `docker compose up --wait` fail, so every deploy
  // of a working tenant reports failure.
  it('refuses a probe that omits the forwarded-proto header', () => {
    expect(() =>
      assertRuntimePosture(
        documentWith({
          ...compliantService(),
          healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', URL] },
        }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/301/);
  });

  it.each([
    ['no healthcheck at all', undefined],
    ['a healthcheck with no test', {}],
    ['an empty test', { test: [] }],
    ['an empty string test', { test: '   ' }],
    ['a CMD form with no command', { test: ['CMD'] }],
    ['a CMD-SHELL form with no command', { test: ['CMD-SHELL', '  '] }],
  ])('refuses %s', (_name, healthcheck) => {
    const service = { ...compliantService(), healthcheck } as Record<string, YamlValue>;
    if (healthcheck === undefined) delete service.healthcheck;
    expect(() =>
      assertRuntimePosture(documentWith(service), { appHostPrivateIp: APP_HOST })
    ).toThrow(/healthcheck\.test/);
  });

  // `test: [NONE]` is how Compose *disables* an inherited probe. It declares
  // a `test` key, so a check looking only for presence accepts it.
  it('refuses a probe disabled with NONE rather than treating it as declared', () => {
    expect(() =>
      assertRuntimePosture(
        documentWith({ ...compliantService(), healthcheck: { test: ['NONE'] } }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/NONE/);
  });

  it.each([
    ['a non-object healthcheck', 'wget'],
    ['a non-array, non-string test', { test: 42 }],
    ['an unrecognised first element', { test: ['SHELL', 'wget'] }],
    ['a non-string element', { test: ['CMD', 'wget', 7] }],
  ])('refuses %s', (_name, healthcheck) => {
    expect(() =>
      assertRuntimePosture(
        documentWith({ ...compliantService(), healthcheck } as Record<string, YamlValue>),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/healthcheck\.test/);
  });

  // The header has to be *bound* to `--header`. Attached to any other option
  // it is still sent somewhere, so a membership test on the argv passes while
  // Ghost goes on answering 301 — the check would then certify the exact
  // defect it exists to catch.
  it.each([
    ['bound to -U, which sends it as the user agent', ['-U', 'X-Forwarded-Proto: https']],
    ['loose in the argv, bound to nothing', ['true', 'X-Forwarded-Proto: https']],
    ['named without its value following', ['--header', '-q', 'X-Forwarded-Proto: https']],
  ])('refuses a probe carrying the header %s', (_name, argv) => {
    expect(() =>
      assertRuntimePosture(
        documentWith({
          ...compliantService(),
          healthcheck: { test: ['CMD', 'wget', ...argv, URL] },
        }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/--header/);
  });

  // Compose accepts four shapes for `test`. A check that reads only the `CMD`
  // array refuses correct stacks, which is worse than useless: it makes the
  // component reject a document Docker would run perfectly.
  it.each([
    ['a glued CMD long option', { test: ['CMD', 'wget', `--header=${HEADER}`, URL] }],
    ['a bare string, the implicit CMD-SHELL form', { test: `wget --header '${HEADER}' ${URL}` }],
    ['an explicit CMD-SHELL', { test: ['CMD-SHELL', `wget --header='${HEADER}' ${URL}`] }],
    ['a double-quoted shell value', { test: ['CMD-SHELL', `wget --header "${HEADER}" ${URL}`] }],
  ])('accepts %s', (_name, healthcheck) => {
    expect(() =>
      assertRuntimePosture(documentWith({ ...compliantService(), healthcheck }), {
        appHostPrivateIp: APP_HOST,
      })
    ).not.toThrow();
  });

  // Unquoted, the shell splits the value: `wget` gets `--header`,
  // `X-Forwarded-Proto:` and a bare `https` it reads as a URL.
  it('refuses an unquoted header in a shell-form probe', () => {
    expect(() =>
      assertRuntimePosture(
        documentWith({
          ...compliantService(),
          healthcheck: { test: ['CMD-SHELL', `wget --header ${HEADER} ${URL}`] },
        }),
        { appHostPrivateIp: APP_HOST }
      )
    ).toThrow(/--header/);
  });

  // The header is Ghost's requirement, not every container's. A sidecar still
  // has to declare a probe that works; it must not have to lie about this one.
  it('requires a probe of every service but the Ghost header only of Ghost', () => {
    const sidecar = {
      ...compliantService(),
      healthcheck: { test: ['CMD', 'nc', '-z', '127.0.0.1', '9100'] },
    };
    const document = {
      name: 'blog',
      services: { ghost: compliantService(), exporter: sidecar },
    } as Record<string, YamlValue>;
    expect(() => assertRuntimePosture(document, { appHostPrivateIp: APP_HOST })).not.toThrow();

    delete (document.services as Record<string, Record<string, YamlValue>>).exporter.healthcheck;
    expect(() => assertRuntimePosture(document, { appHostPrivateIp: APP_HOST })).toThrow(
      /"exporter".*healthcheck\.test/
    );
  });

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
