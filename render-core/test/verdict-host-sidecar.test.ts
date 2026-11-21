/**
 * The per-slot verdict host end, rendered as a `verdict-host` sidecar from the
 * same digest-pinned image as Ghost, with no network at all
 * (`network_mode: none`). See `src/compose.md#the-verdict-host-sidecar`.
 *
 * The network deny is the control, so it is proven red-then-green here: a
 * rendered stack whose sidecar has any network, a published port, or a network
 * mode other than `none`, is refused by `assertRuntimePosture`, and a
 * `compose.ts` mutated to render the route is caught by the same assertions.
 * The live outbound-connect proof is `verdict-host-network.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Port, PrivateIpV4, Slug, TenantUid } from '../src/brand.js';
import type { ComposeStackArgs } from '../src/compose.js';
import {
  VERDICT_HOST_ENTRYPOINT,
  VERDICT_HOST_LIMITS,
  VERDICT_HOST_NETWORK_MODE,
  VERDICT_HOST_SERVICE,
  assertRuntimePosture,
  composeDocument,
  renderComposeStack,
} from '../src/compose.js';
import { mailSpoolNetworkName } from '../src/spool.js';
import { verdictJournalVolumeName, verdictVolumeName } from '../src/naming.js';
import { VERDICT_MOUNT_PATH } from '../src/environment.js';
import type { YamlValue } from '../src/yaml.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const SLUG = 'acme' as Slug;
const UID = 30123 as TenantUid;

const baseArgs: ComposeStackArgs = {
  kind: 'tenant',
  slug: SLUG,
  uid: UID,
  appHostPrivateIp: '10.20.1.50' as PrivateIpV4,
  ports: { a: 3101 as Port, b: 3102 as Port, health: 3103 as Port },
  environment: { url: 'https://blog.acme.example' },
  limits: {
    tmpfsSize: '128m',
    themeCompressedBytes: 1,
    themeEntryUncompressedBytes: 1,
    themeTotalUncompressedBytes: 1,
    edgeRequestBodyMaxSize: '64MiB',
    memoryLimit: '640m',
  },
  caps: { cpus: '1.0', cpuShares: 512, pidsLimit: 256, nofile: 4096 },
  dataMount: null,
  mailNetwork: null,
  verdictVolume: verdictVolumeName(SLUG),
};

type Doc = Record<string, YamlValue>;
type Service = Record<string, YamlValue>;

function servicesOf(document: Doc): Record<string, Service> {
  return document.services as Record<string, Service>;
}

function sidecarOf(document: Doc): Service {
  const sidecar = servicesOf(document)[VERDICT_HOST_SERVICE];
  if (sidecar === undefined) throw new Error('no verdict-host service rendered');
  return sidecar;
}

function clone(document: Doc): Doc {
  return structuredClone(document);
}

/** Every way a rendered document fails to deny the sidecar a route off the
 * host, read from the document alone. The sabotage cases use it to show the
 * control cannot pass on a variant that has a route. */
function networkDenyProblems(document: Doc): string[] {
  const problems: string[] = [];
  const sidecar = servicesOf(document)[VERDICT_HOST_SERVICE];
  if (sidecar === undefined) return ['no verdict-host service'];
  if (sidecar.network_mode !== 'none') problems.push('sidecar has a network');
  if ('networks' in sidecar) problems.push('sidecar lists networks');
  if ('ports' in sidecar) problems.push('sidecar publishes ports');
  return problems;
}

describe('a slot that names the production verdict source', () => {
  const document = composeDocument(baseArgs);
  const sidecar = sidecarOf(document);

  it('renders one verdict-host service beside the two Ghost colours', () => {
    expect(Object.keys(servicesOf(document))).toEqual(['ghost-a', 'ghost-b', VERDICT_HOST_SERVICE]);
  });

  it('runs the same digest-pinned image as Ghost, with its own entrypoint', () => {
    expect(sidecar.image).toBe('${IMAGE}');
    expect(sidecar.image).toBe(servicesOf(document)['ghost-a'].image);
    expect(sidecar.entrypoint).toEqual(['node', VERDICT_HOST_ENTRYPOINT]);
  });

  it('has no network at all, and no network of its own is declared', () => {
    expect(sidecar.network_mode).toBe('none');
    expect(sidecar.network_mode).toBe(VERDICT_HOST_NETWORK_MODE);
    for (const key of ['networks', 'links', 'dns', 'extra_hosts', 'ports', 'expose']) {
      expect(sidecar).not.toHaveProperty(key);
    }
    expect(document.networks).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain('verdict-net');
    expect(networkDenyProblems(document)).toEqual([]);
  });

  it('is joined by no Ghost service, and Ghost keeps the default network', () => {
    for (const colour of ['ghost-a', 'ghost-b']) {
      expect(servicesOf(document)[colour].networks).toBeUndefined();
      expect(servicesOf(document)[colour].network_mode).toBeUndefined();
    }
  });

  it('leaves a Ghost with mail on its own two networks, and the sidecar still has none', () => {
    const mail = mailSpoolNetworkName(UID);
    const withMail = composeDocument({ ...baseArgs, mailNetwork: mail });
    for (const colour of ['ghost-a', 'ghost-b']) {
      expect(servicesOf(withMail)[colour].networks).toEqual(['default', mail]);
    }
    expect(sidecarOf(withMail).network_mode).toBe('none');
    expect(sidecarOf(withMail)).not.toHaveProperty('networks');
    expect(Object.keys(withMail.networks as Doc)).toEqual([mail]);
  });

  it('publishes no port and exposes none', () => {
    expect(sidecar).not.toHaveProperty('ports');
    expect(sidecar).not.toHaveProperty('expose');
    const text = renderComposeStack(baseArgs);
    const sidecarText = text.slice(text.indexOf('  verdict-host:\n'), text.indexOf('\nnetworks:'));
    expect(sidecarText).toContain('verdict-host:');
    expect(sidecarText).not.toContain('ports:');
    expect(sidecarText).not.toContain('expose:');
  });

  it('carries the same posture as Ghost: read-only, no capabilities, no new privileges', () => {
    expect(sidecar.read_only).toBe(true);
    expect(sidecar.init).toBe(true);
    expect(sidecar.cap_drop).toEqual(['ALL']);
    expect(sidecar.security_opt).toEqual(['no-new-privileges:true']);
    expect(sidecar.user).toBe('30123:30123');
    expect(sidecar.tmpfs).toEqual([
      `/tmp:rw,noexec,nosuid,nodev,size=${VERDICT_HOST_LIMITS.tmpfsSize}`,
    ]);
    for (const forbidden of ['privileged', 'cap_add', 'devices', 'pid', 'ipc']) {
      expect(sidecar).not.toHaveProperty(forbidden);
    }
  });

  it("names the slot's own uid and gid for the host end, the ones it runs as", () => {
    // The host end refuses to start without both, and as any other user.
    expect(sidecar.user).toBe('30123:30123');
    expect(sidecar.environment).toMatchObject({
      VERDICT_HOST_SOCKET_UID: '30123',
      VERDICT_HOST_SOCKET_GID: '30123',
    });
    const text = renderComposeStack(baseArgs);
    expect(text).toContain("VERDICT_HOST_SOCKET_UID: '30123'");
    expect(text).toContain("VERDICT_HOST_SOCKET_GID: '30123'");
    // Another slot gets its own.
    const other = composeDocument({ ...baseArgs, uid: 30456 as TenantUid });
    expect(sidecarOf(other).user).toBe('30456:30456');
    expect(sidecarOf(other).environment).toMatchObject({
      VERDICT_HOST_SOCKET_UID: '30456',
      VERDICT_HOST_SOCKET_GID: '30456',
    });
  });

  it('carries resource limits of its own, swap bounded, logs bounded', () => {
    expect(sidecar.mem_limit).toBe(VERDICT_HOST_LIMITS.memoryLimit);
    expect(sidecar.memswap_limit).toBe(VERDICT_HOST_LIMITS.memoryLimit);
    expect(sidecar.pids_limit).toBe(VERDICT_HOST_LIMITS.pidsLimit);
    expect(sidecar.cpus).toBe(VERDICT_HOST_LIMITS.cpus);
    expect(sidecar.cpu_shares).toBe(VERDICT_HOST_LIMITS.cpuShares);
    expect(sidecar.ulimits).toEqual({
      nofile: { soft: VERDICT_HOST_LIMITS.nofile, hard: VERDICT_HOST_LIMITS.nofile },
    });
    expect(sidecar.stop_grace_period).toBe(VERDICT_HOST_LIMITS.stopGracePeriod);
    expect(sidecar.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '3' },
    });
  });

  it('is smaller than Ghost, not the same budget', () => {
    expect(sidecar.mem_limit).not.toBe(servicesOf(document)['ghost-a'].mem_limit);
    expect(Number(sidecar.pids_limit)).toBeLessThan(
      Number(servicesOf(document)['ghost-a'].pids_limit)
    );
  });

  it('mounts the socket volume read-write and its own journal volume, both external', () => {
    const socket = verdictVolumeName(SLUG);
    const journal = verdictJournalVolumeName(SLUG);
    expect(sidecar.volumes).toEqual([
      `${socket}:/var/lib/ghost/verdict`,
      `${journal}:/var/lib/verdict-host`,
    ]);
    const volumes = document.volumes as Record<string, YamlValue>;
    expect(volumes[socket]).toEqual({ external: true });
    expect(volumes[journal]).toEqual({ external: true });
    // Ghost never sees the journal.
    for (const colour of ['ghost-a', 'ghost-b']) {
      const mounts = servicesOf(document)[colour].volumes as string[];
      expect(mounts.some((mount) => mount.startsWith(`${journal}:`))).toBe(false);
      expect(mounts).toContain(`${socket}:/var/lib/ghost/verdict:ro`);
    }
  });

  it('has a healthcheck that asks whether the socket exists, not whether Ghost answers', () => {
    expect(sidecar.healthcheck).toMatchObject({
      test: ['CMD', 'test', '-S', '/var/lib/ghost/verdict/verdict.sock'],
    });
  });

  it('is rendered whichever colour runs, so a one-colour stack does not orphan it', () => {
    for (const activeColour of ['a', 'b'] as const) {
      const one = composeDocument({ ...baseArgs, activeColour });
      expect(Object.keys(servicesOf(one))).toEqual([`ghost-${activeColour}`, VERDICT_HOST_SERVICE]);
      expect(networkDenyProblems(one)).toEqual([]);
    }
  });

  it('passes the posture check as rendered text', () => {
    const yaml = renderComposeStack(baseArgs);
    expect(yaml).toContain('  verdict-host:\n');
    expect(yaml).toContain("    network_mode: 'none'\n");
    expect(yaml).not.toContain('networks:');
  });

  it('two slugs never share a journal volume', () => {
    const other = 'globex' as Slug;
    expect(verdictJournalVolumeName(other)).not.toBe(verdictJournalVolumeName(SLUG));
    expect(
      renderComposeStack({ ...baseArgs, slug: other, verdictVolume: verdictVolumeName(other) })
    ).not.toContain('ghost-acme-');
  });
});

describe('a slot that does not name it', () => {
  it.each([null, undefined])(
    'renders no sidecar, network or journal volume (verdictVolume %s)',
    (value) => {
      const { verdictVolume: _drop, ...rest } = baseArgs;
      const document = composeDocument(
        value === undefined ? rest : { ...rest, verdictVolume: value }
      );
      expect(Object.keys(servicesOf(document))).toEqual(['ghost-a', 'ghost-b']);
      expect(document.networks).toBeUndefined();
      expect(JSON.stringify(document.volumes)).not.toContain('verdict');
    }
  );
});

describe('assertRuntimePosture() on the verdict host end', () => {
  const real = composeDocument(baseArgs);

  function refuses(mutate: (document: Doc) => void, message: RegExp): void {
    const document = clone(real);
    mutate(document);
    expect(() => assertRuntimePosture(document, '10.20.1.50')).toThrow(message);
  }

  it('passes the rendered document', () => {
    expect(() => assertRuntimePosture(real, '10.20.1.50')).not.toThrow();
  });

  it('SABOTAGE — a sidecar on any network is refused, the real render restores green', () => {
    // RED: a sidecar given a network of its own, internal or not, has the
    // host's address on the bridge.
    refuses((document) => {
      delete sidecarOf(document).network_mode;
      sidecarOf(document).networks = ['verdict-net'];
      document.networks = { 'verdict-net': { name: 'verdict-net', internal: true } };
    }, /service "verdict-host": must set `network_mode: none`/);
    // The default network, which has egress.
    refuses((document) => {
      delete sidecarOf(document).network_mode;
    }, /must set `network_mode: none`/);
    // Both set: Compose would refuse it, and so does the posture.
    refuses((document) => {
      sidecarOf(document).networks = ['default'];
    }, /must not set `networks`/);
    refuses((document) => {
      sidecarOf(document).networks = {};
    }, /must not set `networks`/);
    // GREEN
    expect(() => assertRuntimePosture(real, '10.20.1.50')).not.toThrow();
  });

  it.each(['host', 'bridge', 'default', 'service:ghost-a', 'container:other', ''])(
    'SABOTAGE — a sidecar with `network_mode: %s` is refused',
    (mode) => {
      refuses((document) => {
        sidecarOf(document).network_mode = mode;
      }, /service "verdict-host": must (not set `network_mode`|set `network_mode: none`)/);
    }
  );

  it('refuses a sidecar that sets a network-shaped key that has no meaning without one', () => {
    for (const key of ['links', 'dns', 'dns_search', 'extra_hosts', 'mac_address']) {
      refuses(
        (document) => {
          sidecarOf(document)[key] = key === 'mac_address' ? '02:42:ac:11:00:02' : ['x'];
        },
        new RegExp(`must not set \`${key}\``)
      );
    }
  });

  it('SABOTAGE — a Ghost service that shares the sidecar network namespace is refused', () => {
    // RED: Ghost would sit in the namespace the sidecar has.
    refuses((document) => {
      servicesOf(document)['ghost-a'].network_mode = 'service:verdict-host';
    }, /service "ghost-a": must not set `network_mode`/);
    // And a `none` Ghost is not exempt: only the sidecar may set it.
    refuses((document) => {
      servicesOf(document)['ghost-a'].network_mode = 'none';
    }, /service "ghost-a": must not set `network_mode`/);
    // GREEN
    expect(() => assertRuntimePosture(real, '10.20.1.50')).not.toThrow();
  });

  it('SABOTAGE — a published port on the sidecar is refused', () => {
    refuses((document) => {
      sidecarOf(document).ports = ['10.20.1.50:9000:9000'];
    }, /service "verdict-host": must publish no port/);
    refuses((document) => {
      sidecarOf(document).ports = [];
    }, /must publish no port/);
    refuses((document) => {
      sidecarOf(document).expose = ['9000'];
    }, /must not set `expose`/);
  });

  it('SABOTAGE — a Ghost that mounts the verdict volume read-write is refused', () => {
    // RED: Ghost could replace the socket or write beside it.
    for (const colour of ['ghost-a', 'ghost-b']) {
      refuses(
        (document) => {
          const service = servicesOf(document)[colour];
          service.volumes = (service.volumes as string[]).map((volume) =>
            volume.endsWith(`${VERDICT_MOUNT_PATH}:ro`) ? volume.slice(0, -':ro'.length) : volume
          );
        },
        new RegExp(`service "${colour}": must mount the verdict volume read-only`)
      );
    }
    // GREEN
    expect(() => assertRuntimePosture(real, '10.20.1.50')).not.toThrow();
  });

  it('SABOTAGE — a Ghost that mounts a verdict volume at another path is refused, by its source name', () => {
    // RED on main: the check keys on the mount target, so `:/elsewhere` passes.
    for (const colour of ['ghost-a', 'ghost-b']) {
      for (const source of [verdictVolumeName(SLUG), verdictJournalVolumeName(SLUG)]) {
        refuses(
          (document) => {
            const volumes = servicesOf(document)[colour].volumes as YamlValue[];
            servicesOf(document)[colour].volumes = [...volumes, `${source}:/elsewhere`];
          },
          new RegExp(`service "${colour}": must mount the verdict volume read-only`)
        );
      }
    }
    // The same mount read-only is allowed: only a writable one replaces the socket.
    const readOnly = clone(real);
    const volumes = servicesOf(readOnly)['ghost-a'].volumes as YamlValue[];
    servicesOf(readOnly)['ghost-a'].volumes = [
      ...volumes,
      `${verdictVolumeName(SLUG)}:/elsewhere:ro`,
    ];
    expect(() => assertRuntimePosture(readOnly, '10.20.1.50')).not.toThrow();
  });

  it('SABOTAGE — a Ghost that mounts the verdict volume in long syntax is refused', () => {
    // RED on main: mountOf() reads only string volumes, so a mapping passes.
    refuses((document) => {
      const volumes = servicesOf(document)['ghost-a'].volumes as YamlValue[];
      servicesOf(document)['ghost-a'].volumes = [
        ...volumes,
        { type: 'volume', source: verdictVolumeName(SLUG), target: '/elsewhere' },
      ];
    }, /service "ghost-a": must mount the verdict volume read-only/);
  });

  it('SABOTAGE — a Ghost that inherits the sidecar mounts through volumes_from is refused', () => {
    // RED on main: volumes_from is not a forbidden key, so the volumes check never sees it.
    refuses((document) => {
      servicesOf(document)['ghost-a'].volumes_from = [VERDICT_HOST_SERVICE];
    }, /service "ghost-a": must not set `volumes_from`/);
  });

  it('SABOTAGE — a verdict volume with no sidecar is refused, mounted or only declared', () => {
    // RED: Ghost dials a socket that nothing makes.
    refuses((document) => {
      delete servicesOf(document)[VERDICT_HOST_SERVICE];
      delete document.networks;
    }, /service "ghost-a": mounts the verdict volume at `\/var\/lib\/ghost\/verdict` but no `verdict-host` service/);
    // A declared volume nothing uses is refused too.
    refuses((document) => {
      const services = servicesOf(document);
      delete services[VERDICT_HOST_SERVICE];
      delete document.networks;
      for (const colour of ['ghost-a', 'ghost-b']) {
        services[colour].volumes = (services[colour].volumes as string[]).filter(
          (volume) => !volume.includes(VERDICT_MOUNT_PATH)
        );
      }
    }, /volume "ghost-acme-verdict": a verdict volume is declared but no `verdict-host` service uses it/);
    // GREEN: a slot that never named the verdict source renders none of it.
    const { verdictVolume: _drop, ...without } = baseArgs;
    expect(() => composeDocument(without)).not.toThrow();
    expect(() => assertRuntimePosture(composeDocument(without), '10.20.1.50')).not.toThrow();
    expect(() => assertRuntimePosture(real, '10.20.1.50')).not.toThrow();
  });

  const DROPS: readonly [string, (service: Service) => void, RegExp][] = [
    ['read_only', (s) => void (s.read_only = false), /read_only: true/],
    ['cap_drop', (s) => void (s.cap_drop = []), /cap_drop: \[ALL\]/],
    ['no-new-privileges', (s) => void (s.security_opt = []), /no-new-privileges/],
    ['pids_limit', (s) => void delete s.pids_limit, /must set `pids_limit`/],
    ['mem_limit', (s) => void delete s.mem_limit, /must set `mem_limit`/],
    ['cpus', (s) => void delete s.cpus, /must set `cpus`/],
    ['memswap_limit', (s) => void (s.memswap_limit = '1g'), /memswap_limit/],
    [
      'a named volume (a host path)',
      (s) => void (s.volumes = ['/srv/verdict:/var/lib/ghost/verdict']),
      /never a host path/,
    ],
    ['cap_add', (s) => void (s.cap_add = ['NET_RAW']), /must not set `cap_add`/],
    ['network_mode', (s) => void (s.network_mode = 'host'), /must not set `network_mode`/],
  ];

  it.each(DROPS)('refuses a sidecar that breaks %s', (_name, mutate, message) => {
    refuses((document) => {
      mutate(sidecarOf(document));
    }, message);
  });

  it('refuses a sidecar with no healthcheck', () => {
    refuses((document) => {
      delete sidecarOf(document).healthcheck;
    }, /must declare a `healthcheck.test`/);
  });

  it('does not ask the sidecar for the Ghost probe header', () => {
    expect(() => assertRuntimePosture(real, '10.20.1.50')).not.toThrow();
  });

  it('still asks Ghost for its probe header, with the sidecar beside it', () => {
    refuses((document) => {
      servicesOf(document)['ghost-a'].healthcheck = {
        test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:2368/'],
      };
    }, /service "ghost-a": must bind `X-Forwarded-Proto: https`/);
  });
});

describe('the network deny is in compose.ts and nowhere weaker', () => {
  it('SABOTAGE — a compose.ts that renders the sidecar with a network is refused by its own posture check; the real one renders', async () => {
    // RED: only the `network_mode` line is replaced by a network; the posture
    // check still runs.
    const sabotaged = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const target = '    network_mode: VERDICT_HOST_NETWORK_MODE,\n';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(target, "    networks: ['default'],\n");
      }
    );
    expect(() => sabotaged.renderComposeStack(baseArgs)).toThrow(
      /service "verdict-host": must set `network_mode: none`/
    );
    // GREEN
    expect(() => renderComposeStack(baseArgs)).not.toThrow();
  });

  it('SABOTAGE — with the posture check also gone, the document tests still see the route', async () => {
    // RED: the sidecar is given the default network and the posture check
    // removed, so a route is rendered. The structural assertions above must flag
    // it on their own.
    const sabotaged = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const mode = '    network_mode: VERDICT_HOST_NETWORK_MODE,\n';
        const check = 'checkVerdictHostNetwork(services, problems);';
        if (!source.includes(mode) || !source.includes(check)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(mode, '').replace(check, '');
      }
    );
    const document = sabotaged.composeDocument(baseArgs);
    expect(networkDenyProblems(document)).toEqual(['sidecar has a network']);
    expect(sabotaged.renderComposeStack(baseArgs)).not.toContain("network_mode: 'none'");
    // GREEN: the real module has no route.
    expect(networkDenyProblems(composeDocument(baseArgs))).toEqual([]);
    expect(renderComposeStack(baseArgs)).toContain("network_mode: 'none'");
  });

  it('SABOTAGE — a compose.ts that renders no socket uid or gid for the host end is caught by the render test', async () => {
    // RED: the host end would refuse to start without them (PR 1007).
    const sabotaged = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const target = '      VERDICT_HOST_SOCKET_UID: String(args.uid),\n';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(target, '');
      }
    );
    const environment = sidecarOf(sabotaged.composeDocument(baseArgs)).environment as Record<
      string,
      YamlValue
    >;
    expect(environment).not.toHaveProperty('VERDICT_HOST_SOCKET_UID');
    // GREEN
    expect(sidecarOf(composeDocument(baseArgs)).environment).toHaveProperty(
      'VERDICT_HOST_SOCKET_UID'
    );
  });

  it('SABOTAGE — a compose.ts that gives a Ghost colour the sidecar network mode is refused', async () => {
    // RED: both Ghost colours are put in the sidecar's network namespace.
    const sabotaged = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const target = "...(args.mailNetwork ? { networks: ['default', args.mailNetwork] } : {}),";
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(target, "network_mode: 'service:verdict-host',");
      }
    );
    expect(() => sabotaged.renderComposeStack(baseArgs)).toThrow(
      /service "ghost-a": must not set `network_mode`/
    );
    // GREEN
    expect(() => renderComposeStack(baseArgs)).not.toThrow();
  });
});
