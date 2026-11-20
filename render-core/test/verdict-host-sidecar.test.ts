/**
 * The per-slot verdict host end, rendered as a `verdict-host` sidecar from the
 * same digest-pinned image as Ghost, on a per-slot `internal: true` network
 * and no other. See `src/compose.md#the-verdict-host-sidecar`.
 *
 * The network deny is the control, so it is proven red-then-green here: a
 * rendered stack whose sidecar network is not `internal`, or that an extra
 * network or a Ghost service joins, is refused by `assertRuntimePosture`, and a
 * `compose.ts` mutated to render the route is caught by the same assertions.
 * The live outbound-connect proof is `verdict-host-network.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Port, PrivateIpV4, Slug, TenantUid } from '../src/brand.js';
import type { ComposeStackArgs } from '../src/compose.js';
import {
  VERDICT_HOST_ENTRYPOINT,
  VERDICT_HOST_LIMITS,
  VERDICT_HOST_SERVICE,
  assertRuntimePosture,
  composeDocument,
  renderComposeStack,
} from '../src/compose.js';
import { mailSpoolNetworkName } from '../src/spool.js';
import { verdictJournalVolumeName, verdictNetworkName, verdictVolumeName } from '../src/naming.js';
import type { YamlValue } from '../src/yaml.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const SLUG = 'acme' as Slug;
const UID = 30123 as TenantUid;
const VERDICT_NETWORK = verdictNetworkName(SLUG);

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

function networksOf(document: Doc): Record<string, Record<string, YamlValue>> {
  return (document.networks ?? {}) as Record<string, Record<string, YamlValue>>;
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
  const services = servicesOf(document);
  const sidecar = services[VERDICT_HOST_SERVICE];
  if (sidecar === undefined) return ['no verdict-host service'];
  const joined = Array.isArray(sidecar.networks) ? (sidecar.networks as string[]) : [];
  if (joined.length !== 1) problems.push(`sidecar joins ${joined.length} networks`);
  for (const name of joined) {
    const network = networksOf(document)[name];
    if (network === undefined) problems.push(`network ${name} is not declared`);
    else if (network.internal !== true) problems.push(`network ${name} is not internal`);
    else if (network.external === true) problems.push(`network ${name} is external`);
  }
  if ('ports' in sidecar) problems.push('sidecar publishes ports');
  for (const [name, service] of Object.entries(services)) {
    if (name === VERDICT_HOST_SERVICE) continue;
    const theirs = Array.isArray(service.networks) ? (service.networks as string[]) : [];
    if (theirs.some((network) => joined.includes(network))) {
      problems.push(`${name} joins the sidecar network`);
    }
  }
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

  it('joins exactly one network, which is internal, owned by the stack and its own', () => {
    expect(sidecar.networks).toEqual([VERDICT_NETWORK]);
    expect(VERDICT_NETWORK).toBe('ghost-acme-verdict-net');
    expect(networksOf(document)[VERDICT_NETWORK]).toEqual({
      name: VERDICT_NETWORK,
      internal: true,
    });
    expect(networkDenyProblems(document)).toEqual([]);
  });

  it('is joined by no Ghost service, and Ghost keeps the default network', () => {
    for (const colour of ['ghost-a', 'ghost-b']) {
      expect(servicesOf(document)[colour].networks).toBeUndefined();
    }
  });

  it('leaves a Ghost with mail on its own two networks, never the verdict network', () => {
    const mail = mailSpoolNetworkName(UID);
    const withMail = composeDocument({ ...baseArgs, mailNetwork: mail });
    for (const colour of ['ghost-a', 'ghost-b']) {
      expect(servicesOf(withMail)[colour].networks).toEqual(['default', mail]);
    }
    expect(sidecarOf(withMail).networks).toEqual([VERDICT_NETWORK]);
    expect(Object.keys(networksOf(withMail)).sort()).toEqual([mail, VERDICT_NETWORK].sort());
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
    for (const forbidden of ['privileged', 'cap_add', 'network_mode', 'devices', 'pid', 'ipc']) {
      expect(sidecar).not.toHaveProperty(forbidden);
    }
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
    expect(yaml).toContain(
      `  ${VERDICT_NETWORK}:\n    name: '${VERDICT_NETWORK}'\n    internal: true\n`
    );
  });

  it('two slugs never share a verdict network or journal volume', () => {
    const other = 'globex' as Slug;
    expect(verdictNetworkName(other)).not.toBe(VERDICT_NETWORK);
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

  it('SABOTAGE — a verdict network that is not internal is refused, the real render restores green', () => {
    // RED: the network has a gateway, so the process has a route off the host.
    refuses((document) => {
      networksOf(document)[VERDICT_NETWORK].internal = false;
    }, /joins network "ghost-acme-verdict-net", which is not `internal: true`/);
    refuses((document) => {
      delete networksOf(document)[VERDICT_NETWORK].internal;
    }, /not `internal: true`/);
    // GREEN
    expect(() => assertRuntimePosture(real, '10.20.1.50')).not.toThrow();
  });

  it('refuses an external verdict network, which this file does not own', () => {
    refuses((document) => {
      networksOf(document)[VERDICT_NETWORK].external = true;
    }, /must be owned by this file/);
  });

  it('refuses an IPv6 verdict network', () => {
    refuses((document) => {
      networksOf(document)[VERDICT_NETWORK].enable_ipv6 = true;
    }, /must not set `enable_ipv6`/);
  });

  it('SABOTAGE — a sidecar that also joins the default network is refused', () => {
    refuses((document) => {
      sidecarOf(document).networks = [VERDICT_NETWORK, 'default'];
    }, /must list exactly one network/);
  });

  it('refuses a sidecar with no networks, which Compose reads as the default network', () => {
    refuses((document) => {
      delete sidecarOf(document).networks;
    }, /must list exactly one network/);
  });

  it('refuses a sidecar joined to a network the file does not declare', () => {
    refuses((document) => {
      sidecarOf(document).networks = ['elsewhere'];
    }, /which the file does not declare/);
  });

  it('SABOTAGE — a Ghost service that joins the verdict network is refused', () => {
    refuses((document) => {
      servicesOf(document)['ghost-a'].networks = ['default', VERDICT_NETWORK];
    }, /service "ghost-a": must not join the verdict host's network/);
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
  it('SABOTAGE — a compose.ts that renders the network without `internal` is refused by its own posture check; the real one renders', async () => {
    // RED: only the `internal` line is dropped; the posture check still runs.
    const sabotaged = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const target = '{ name: verdictNetwork, internal: true }';
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(target, '{ name: verdictNetwork }');
      }
    );
    expect(() => sabotaged.renderComposeStack(baseArgs)).toThrow(/which is not `internal: true`/);
    // GREEN
    expect(() => renderComposeStack(baseArgs)).not.toThrow();
  });

  it('SABOTAGE — with the posture check also gone, the document tests still see the route', async () => {
    // RED: `internal` is dropped and the posture check removed, so a route is
    // rendered. The structural assertions above must flag it on their own.
    const sabotaged = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const internal = '{ name: verdictNetwork, internal: true }';
        const check = 'checkVerdictHostNetwork(document, services, problems);';
        if (!source.includes(internal) || !source.includes(check)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(internal, '{ name: verdictNetwork }').replace(check, '');
      }
    );
    const document = sabotaged.composeDocument(baseArgs);
    expect(networkDenyProblems(document)).toEqual([`network ${VERDICT_NETWORK} is not internal`]);
    expect(sabotaged.renderComposeStack(baseArgs)).not.toContain('internal: true');
    // GREEN: the real module has no route.
    expect(networkDenyProblems(composeDocument(baseArgs))).toEqual([]);
    expect(renderComposeStack(baseArgs)).toContain('internal: true');
  });

  it('SABOTAGE — a compose.ts that lets a Ghost colour join the verdict network is refused', async () => {
    // RED: both Ghost colours are given the sidecar's network.
    const sabotaged = await importSabotaged<typeof import('../src/compose.js')>(
      'compose.ts',
      (source) => {
        const target = "...(args.mailNetwork ? { networks: ['default', args.mailNetwork] } : {}),";
        if (!source.includes(target)) {
          throw new Error('sabotage target not found in compose.ts -- update the mutation');
        }
        return source.replace(target, 'networks: [verdictNetworkName(args.slug)],');
      }
    );
    expect(() => sabotaged.renderComposeStack(baseArgs)).toThrow(
      /service "ghost-a": must not join the verdict host's network/
    );
    // GREEN
    expect(() => renderComposeStack(baseArgs)).not.toThrow();
  });
});
