import { afterAll, describe, expect, it } from 'vitest';
import type { DigestPinnedRef, Port, TenantUid } from '../src/brand.js';
import { tenantEnvironment } from '../src/environment.js';
import { secretsEnvPath } from '../src/naming.js';
import { render } from '../src/render.js';
import { uploadLimits } from '../src/runtime.js';
import {
  MAIL_SPOOL_BASE_URL,
  MAIL_SPOOL_DATA_VOLUME,
  MAIL_SPOOL_DRAIN_ADDRESS,
  MAIL_SPOOL_DRAIN_BRIDGE,
  MAIL_SPOOL_DRAIN_CONTAINER_PORT,
  MAIL_SPOOL_DRAIN_GATEWAY,
  MAIL_SPOOL_DRAIN_NETWORK,
  MAIL_SPOOL_DRAIN_SUBNET,
  MAIL_SPOOL_HTTP_PORT,
  MAIL_SPOOL_SERVICE,
  MAIL_SPOOL_SMTP_PORT,
  MAIL_SPOOL_UID,
  assertSpoolPosture,
  mailSpoolDocument,
  mailSpoolNetworkName,
  renderMailSpoolStack,
  type MailSpoolStackArgs,
} from '../src/spool.js';
import { validate } from '../src/validate.js';
import type { YamlValue } from '../src/yaml.js';
import {
  TEST_ZONES,
  demoDescriptor,
  entryTenantDescriptor,
  professionalTenantDescriptor,
} from './fixtures.js';
import { cleanupSabotageTmp, importSabotaged } from './helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const SPOOL_IMAGE = `ghcr.io/branchleft/mailgun-shim@sha256:${'a'.repeat(64)}` as DigestPinnedRef;
const DRAIN_PORT = 8095 as Port;
const DEMO_SLOT_UIDS = [30001, 30002, 30003, 30004, 30005, 30006, 30007] as TenantUid[];

function demoHostArgs(): MailSpoolStackArgs {
  return { image: SPOOL_IMAGE, uids: DEMO_SLOT_UIDS, drainPort: DRAIN_PORT };
}

function appHostArgs(): MailSpoolStackArgs {
  return {
    image: SPOOL_IMAGE,
    uids: [entryTenantDescriptor().uid, professionalTenantDescriptor().uid],
    drainPort: DRAIN_PORT,
  };
}

type Doc = Record<string, YamlValue>;
type Rec = Record<string, YamlValue>;

function spoolService(document: Doc): Rec {
  return (document.services as Rec)[MAIL_SPOOL_SERVICE] as Rec;
}

function networksOf(document: Doc): Rec {
  return document.networks as Rec;
}

/** A fresh, posture-compliant spool document for building sabotaged variants. */
function okDocument(): Doc {
  return structuredClone(mailSpoolDocument(demoHostArgs())) as Doc;
}

/**
 * The container ports a service publishes, whatever the host side says. The
 * exact check for "only the drain listener is published": an entry's last
 * `:`-separated field, minus any `/proto`, as a number.
 */
function publishedContainerPorts(service: Rec): number[] {
  const ports = Array.isArray(service.ports) ? service.ports : [];
  return ports.map((entry) => Number(/(\d+)(?:\/\w+)?$/.exec(String(entry))?.[1]));
}

function postureOf(document: Doc): () => void {
  return () => assertSpoolPosture(document, DRAIN_PORT);
}

describe('renderMailSpoolStack()', () => {
  it.each([
    ['a demo host', demoHostArgs],
    ['an app host', appHostArgs],
  ] as const)('renders exactly one spool service for %s', (_label, args) => {
    const document = mailSpoolDocument(args());
    expect(Object.keys(document.services as Rec)).toEqual([MAIL_SPOOL_SERVICE]);
    expect(() => renderMailSpoolStack(args())).not.toThrow();
  });

  it('gives each tenant its own internal network, keyed on uid, and the drain network nothing else', () => {
    const document = mailSpoolDocument(demoHostArgs());
    const service = spoolService(document);
    const expected = DEMO_SLOT_UIDS.map(mailSpoolNetworkName);
    expect(Object.keys(service.networks as Rec)).toEqual([MAIL_SPOOL_DRAIN_NETWORK, ...expected]);
    expect((service.networks as Rec)[MAIL_SPOOL_DRAIN_NETWORK]).toEqual({
      ipv4_address: MAIL_SPOOL_DRAIN_ADDRESS,
    });
    for (const name of expected) {
      expect((service.networks as Rec)[name]).toEqual({ aliases: [MAIL_SPOOL_SERVICE] });
      expect(networksOf(document)[name]).toEqual({ name, internal: true });
    }
    expect(networksOf(document)[MAIL_SPOOL_DRAIN_NETWORK]).toEqual({
      name: MAIL_SPOOL_DRAIN_NETWORK,
      driver: 'bridge',
      driver_opts: {
        'com.docker.network.bridge.name': MAIL_SPOOL_DRAIN_BRIDGE,
        'com.docker.network.bridge.enable_ip_masquerade': 'false',
      },
      ipam: { config: [{ subnet: MAIL_SPOOL_DRAIN_SUBNET, gateway: MAIL_SPOOL_DRAIN_GATEWAY }] },
    });
  });

  it('gives the drain network one fixed pool, and the spool a fixed address inside it', () => {
    expect(MAIL_SPOOL_DRAIN_SUBNET).toBe('10.231.200.0/29');
    expect(MAIL_SPOOL_DRAIN_GATEWAY).toBe('10.231.200.1');
    expect(MAIL_SPOOL_DRAIN_ADDRESS).toBe('10.231.200.2');
    const environment = spoolService(mailSpoolDocument(demoHostArgs())).environment as Rec;
    expect(environment.SHIM_DRAIN_HOST).toBe(MAIL_SPOOL_DRAIN_ADDRESS);
  });

  it('keeps the drain bridge name inside demo1 egress policy match and the kernel interface-name limit', () => {
    expect(MAIL_SPOOL_DRAIN_BRIDGE.startsWith('br-')).toBe(true);
    expect(MAIL_SPOOL_DRAIN_BRIDGE.length).toBeLessThanOrEqual(15);
  });

  it('publishes one port only: the drain port, on host loopback', () => {
    const service = spoolService(mailSpoolDocument(demoHostArgs()));
    expect(service.ports).toEqual(['127.0.0.1:8095:8081']);
  });

  it('serves the drain handover on a listener of its own, never the one the tenant networks reach', () => {
    const service = spoolService(mailSpoolDocument(demoHostArgs()));
    const environment = service.environment as Rec;
    expect(MAIL_SPOOL_DRAIN_CONTAINER_PORT).not.toBe(MAIL_SPOOL_HTTP_PORT);
    expect(environment.PORT).toBe(MAIL_SPOOL_HTTP_PORT);
    expect(environment.SHIM_DRAIN_PORT).toBe(MAIL_SPOOL_DRAIN_CONTAINER_PORT);
    // Exactly the drain listener is published: not "no entry contains :8080",
    // which a strict-equality toContain on an array can never fail.
    expect(publishedContainerPorts(service)).toEqual([MAIL_SPOOL_DRAIN_CONTAINER_PORT]);
  });

  it('CONTROL for the exact check: a document that publishes the mail API port is reported, and the old assertion stayed green on it', () => {
    const document = okDocument();
    spoolService(document).ports = [`127.0.0.1:${DRAIN_PORT}:${MAIL_SPOOL_HTTP_PORT}`];
    const service = spoolService(document);
    // RED: the exact check reports the mail API port.
    expect(publishedContainerPorts(service)).toEqual([MAIL_SPOOL_HTTP_PORT]);
    expect(publishedContainerPorts(service)).not.toEqual([MAIL_SPOOL_DRAIN_CONTAINER_PORT]);
    // The replaced assertion, verbatim, passes on that same broken document.
    expect(() =>
      expect(service.ports).not.toContain(expect.stringContaining(`:${MAIL_SPOOL_HTTP_PORT}`))
    ).not.toThrow();
  });

  it('pins the image by digest in the rendered file itself', () => {
    const yaml = renderMailSpoolStack(demoHostArgs());
    expect(yaml).toContain(`image: '${SPOOL_IMAGE}'`);
  });

  it('carries no secret: the drain token is a required reference into the operator-written file', () => {
    const yaml = renderMailSpoolStack(demoHostArgs());
    expect(yaml).toContain(
      "SHIM_DRAIN_TOKEN: '${SHIM_DRAIN_TOKEN:?set SHIM_DRAIN_TOKEN in /etc/branchleft/mail-spool.env}'"
    );
    const environment = spoolService(mailSpoolDocument(demoHostArgs())).environment as Rec;
    expect(Object.keys(environment).sort()).toEqual(
      [
        'PORT',
        'SHIM_DB_PATH',
        'SHIM_DRAIN_HOST',
        'SHIM_DRAIN_PORT',
        'SHIM_DRAIN_TOKEN',
        'SMTP_LISTEN_PORT',
      ].sort()
    );
  });

  it('keeps the queue on the host volume no slot owns, as its own uid', () => {
    const service = spoolService(mailSpoolDocument(demoHostArgs()));
    expect(service.volumes).toEqual([`${MAIL_SPOOL_DATA_VOLUME}:/data`]);
    expect(service.user).toBe(`${MAIL_SPOOL_UID}:${MAIL_SPOOL_UID}`);
    expect((service.environment as Rec).SHIM_DB_PATH).toBe('/data/spool.sqlite');
    expect(MAIL_SPOOL_UID).toBeGreaterThan(30999);
  });

  it('dedupes and sorts uids, so the same host set always renders the same file', () => {
    const shuffled = {
      ...demoHostArgs(),
      uids: [...DEMO_SLOT_UIDS].reverse().concat(30001 as TenantUid),
    };
    expect(renderMailSpoolStack(shuffled)).toBe(renderMailSpoolStack(demoHostArgs()));
  });

  it('starts with the do-not-hand-edit header', () => {
    expect(renderMailSpoolStack(demoHostArgs()).startsWith("# The host's one mail spool")).toBe(
      true
    );
  });

  it.each([
    ['no uid at all', { uids: [] as TenantUid[] }, /nothing to queue/],
    ['a uid outside the tenant range', { uids: [1000 as TenantUid] }, /reserved tenant range/],
    [
      'an image with no digest',
      { image: 'ghcr.io/x/shim:latest' as DigestPinnedRef },
      /digest-pinned/,
    ],
    ['a drain port out of range', { drainPort: 70000 as Port }, /1-65535/],
  ] as const)('refuses %s', (_label, override, message) => {
    expect(() => renderMailSpoolStack({ ...demoHostArgs(), ...override })).toThrow(message);
  });
});

describe("Ghost's mail environment and the spool agree, from one source", () => {
  function spoolEnv(): Rec {
    return spoolService(mailSpoolDocument(demoHostArgs())).environment as Rec;
  }

  it('the bulk base URL is the spool service name and its HTTP listener port', () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const env = tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(env.bulkEmail__mailgun__baseUrl).toBe(`http://${MAIL_SPOOL_SERVICE}:${spoolEnv().PORT}`);
    expect(env.bulkEmail__mailgun__baseUrl).toBe(MAIL_SPOOL_BASE_URL);
  });

  it("a queue transport's SMTP host and port are the spool's service name and SMTP listener", () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const env = tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(env.mail__transport).toBe('SMTP');
    expect(env.mail__options__host).toBe(MAIL_SPOOL_SERVICE);
    expect(env.mail__options__port).toBe(spoolEnv().SMTP_LISTEN_PORT);
    expect(env.mail__options__port).toBe(MAIL_SPOOL_SMTP_PORT);
    expect(env.mail__options__secure).toBe(false);
  });

  it("the SMTP credential is the tenant's credential domain and the bulk path's own key, never a literal", () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const env = tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(env.mail__options__auth__user).toBe(env.bulkEmail__mailgun__domain);
    expect(env.mail__options__auth__pass).toBe(env.bulkEmail__mailgun__apiKey);
    expect(env.mail__options__auth__pass).toMatch(/^\$\{GHOST_BULK_EMAIL_API_KEY:\?/);
  });

  it("Ghost joins exactly the internal network the spool renders for that Ghost's uid", () => {
    const descriptor = validate(demoDescriptor(), TEST_ZONES);
    const compose = render(descriptor, TEST_ZONES).find((a) => a.path === 'compose.yml')!.content;
    const network = mailSpoolNetworkName(descriptor.uid);
    expect(compose).toContain(`      - '${network}'`);
    expect(compose).toContain(`  ${network}:\n    name: '${network}'\n    external: true`);
    const spoolNetworks = networksOf(mailSpoolDocument(demoHostArgs()));
    expect(spoolNetworks[network]).toEqual({ name: network, internal: true });
    expect(Object.keys(spoolService(mailSpoolDocument(demoHostArgs())).networks as Rec)).toContain(
      network
    );
  });

  it('a tenant with mail disabled gets no spool network and no transport', () => {
    const disabled = demoDescriptor();
    const descriptor = validate(
      { ...disabled, mail: { ...disabled.mail, enabled: false } },
      TEST_ZONES
    );
    const env = tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(env.mail__transport).toBeUndefined();
    expect(env.mail__options__auth__pass).toBeUndefined();
    expect(env.bulkEmail__mailgun__baseUrl).toBeUndefined();
    const compose = render(descriptor, TEST_ZONES).find((a) => a.path === 'compose.yml')!.content;
    expect(compose).not.toContain('branchleft-mail-');
    expect(compose).not.toMatch(/^networks:/m);
  });

  it('an smtp transport keeps its own host, and only the bulk path is pointed at the spool', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const env = tenantEnvironment(
      descriptor,
      uploadLimits(),
      secretsEnvPath(descriptor.slug),
      TEST_ZONES
    );
    expect(env.mail__options__host).toBe('mx.internal');
    expect(env.mail__options__auth__pass).toMatch(/^\$\{GHOST_MAIL_PASSWORD:\?/);
    expect(env.bulkEmail__mailgun__baseUrl).toBe(MAIL_SPOOL_BASE_URL);
  });
});

describe('assertSpoolPosture() -- every refusal is red on its sabotage and green on the real render', () => {
  it('GREEN: the real rendered spool passes', () => {
    expect(postureOf(okDocument())).not.toThrow();
    expect(postureOf(mailSpoolDocument(appHostArgs()))).not.toThrow();
  });

  const sabotages: ReadonlyArray<readonly [string, (d: Doc) => void, RegExp]> = [
    [
      'a published public port',
      (d) => {
        (spoolService(d).ports as string[]).push(`0.0.0.0:2525:${MAIL_SPOOL_SMTP_PORT}`);
      },
      /publishes exactly one port/,
    ],
    [
      'the drain port bound to a private address instead of loopback',
      (d) => {
        spoolService(d).ports = [`10.20.1.50:${DRAIN_PORT}:${MAIL_SPOOL_DRAIN_CONTAINER_PORT}`];
      },
      /on host loopback only/,
    ],
    [
      'the drain port bound to every address',
      (d) => {
        spoolService(d).ports = [`${DRAIN_PORT}:${MAIL_SPOOL_DRAIN_CONTAINER_PORT}`];
      },
      /publishes exactly one port/,
    ],
    [
      'the drain port published from the mail API listener',
      (d) => {
        spoolService(d).ports = [`127.0.0.1:${DRAIN_PORT}:${MAIL_SPOOL_HTTP_PORT}`];
      },
      /publishes exactly one port/,
    ],
    [
      'no separate drain listener configured, so /drain shares the mail API listener',
      (d) => {
        delete (spoolService(d).environment as Rec).SHIM_DRAIN_PORT;
      },
      /\/drain on the tenant-facing listener/,
    ],
    [
      'the drain listener set to the mail API port',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_PORT = MAIL_SPOOL_HTTP_PORT;
      },
      /\/drain on the tenant-facing listener/,
    ],
    [
      'the mail API listener moved onto the drain listener port',
      (d) => {
        (spoolService(d).environment as Rec).PORT = MAIL_SPOOL_DRAIN_CONTAINER_PORT;
      },
      /\/drain on the tenant-facing listener/,
    ],
    [
      'a drain port with no SHIM_DRAIN_HOST',
      (d) => {
        delete (spoolService(d).environment as Rec).SHIM_DRAIN_HOST;
      },
      /must set SHIM_DRAIN_HOST/,
    ],
    [
      'an empty SHIM_DRAIN_HOST',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_HOST = '';
      },
      /must set SHIM_DRAIN_HOST/,
    ],
    [
      'the drain host set to 0.0.0.0',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_HOST = '0.0.0.0';
      },
      /must not be a wildcard address \(0\.0\.0\.0\)/,
    ],
    [
      'the drain host set to ::',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_HOST = '::';
      },
      /must not be a wildcard address \(::\)/,
    ],
    [
      'the drain host set to a spelled-out all-zero IPv6 address',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_HOST = '0:0:0:0:0:0:0:0';
      },
      /must not be a wildcard address/,
    ],
    [
      'the drain host set to an address on a tenant network',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_HOST = '172.20.0.2';
      },
      /must be the spool's fixed drain address/,
    ],
    [
      'the drain host set to loopback, which Docker cannot forward the published port to',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_HOST = '127.0.0.1';
      },
      /must be the spool's fixed drain address/,
    ],
    [
      'the drain network ipam subnet changed',
      (d) => {
        const pool = ((networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).ipam as Rec).config as Rec[];
        pool[0].subnet = '10.231.201.0/29';
      },
      /exactly the ipam pool subnet/,
    ],
    [
      'the drain network ipam gateway changed',
      (d) => {
        const pool = ((networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).ipam as Rec).config as Rec[];
        pool[0].gateway = '10.231.200.6';
      },
      /exactly the ipam pool subnet/,
    ],
    [
      'the drain network ipam pool given an ip_range, which narrows the addresses Docker hands out',
      (d) => {
        const pool = ((networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).ipam as Rec).config as Rec[];
        pool[0].ip_range = '10.231.200.2/32';
      },
      /exactly the ipam pool subnet/,
    ],
    [
      'the drain network ipam pool given aux_addresses, which reserves addresses Docker must skip',
      (d) => {
        const pool = ((networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).ipam as Rec).config as Rec[];
        pool[0].aux_addresses = { reserved: '10.231.200.5' };
      },
      /exactly the ipam pool subnet/,
    ],
    [
      'the drain network with no ipam block',
      (d) => {
        delete (networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).ipam;
      },
      /exactly the ipam pool subnet/,
    ],
    [
      "the service's ipv4_address on the drain network differing from SHIM_DRAIN_HOST",
      (d) => {
        ((spoolService(d).networks as Rec)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).ipv4_address =
          '10.231.200.3';
      },
      /must set ipv4_address to SHIM_DRAIN_HOST/,
    ],
    [
      'no ipv4_address on the drain network, so the container gets any address',
      (d) => {
        (spoolService(d).networks as Rec)[MAIL_SPOOL_DRAIN_NETWORK] = {
          aliases: [MAIL_SPOOL_SERVICE],
        };
      },
      /must set ipv4_address to SHIM_DRAIN_HOST/,
    ],
    [
      'the list form of networks, which cannot carry a fixed address',
      (d) => {
        spoolService(d).networks = [MAIL_SPOOL_DRAIN_NETWORK];
      },
      /must set ipv4_address to SHIM_DRAIN_HOST/,
    ],
    [
      'an `expose` entry',
      (d) => {
        spoolService(d).expose = [String(MAIL_SPOOL_SMTP_PORT)];
      },
      /must not set `expose`/,
    ],
    [
      'a default egress network joined',
      (d) => {
        (spoolService(d).networks as Rec).default = { aliases: [MAIL_SPOOL_SERVICE] };
        networksOf(d).default = {};
      },
      /not `internal: true`/,
    ],
    [
      'a tenant network that is not internal',
      (d) => {
        networksOf(d)[mailSpoolNetworkName(30001 as TenantUid)] = { name: 'x' };
      },
      /not `internal: true`/,
    ],
    [
      'a tenant network the file does not own',
      (d) => {
        networksOf(d)[mailSpoolNetworkName(30001 as TenantUid)] = {
          internal: true,
          external: true,
        };
      },
      /must be owned by this file/,
    ],
    [
      'no networks listed, so Compose joins the default one',
      (d) => {
        delete spoolService(d).networks;
      },
      /must list its networks explicitly/,
    ],
    [
      'a network the file does not declare',
      (d) => {
        (spoolService(d).networks as Rec)['host-net'] = { aliases: [MAIL_SPOOL_SERVICE] };
      },
      /does not declare/,
    ],
    [
      'IP masquerade back on for the drain network',
      (d) => {
        ((networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).driver_opts as Rec)[
          'com.docker.network.bridge.enable_ip_masquerade'
        ] = 'true';
      },
      /must disable IP masquerade/,
    ],
    [
      'the drain bridge renamed out of the host policy',
      (d) => {
        ((networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).driver_opts as Rec)[
          'com.docker.network.bridge.name'
        ] = 'mailspool0';
      },
      /must use the bridge name/,
    ],
    [
      'the drain network made external',
      (d) => {
        (networksOf(d)[MAIL_SPOOL_DRAIN_NETWORK] as Rec).external = true;
      },
      /plain bridge this file owns/,
    ],
    [
      'network_mode: host',
      (d) => {
        spoolService(d).network_mode = 'host';
      },
      /must not set `network_mode`/,
    ],
    [
      'a literal drain token',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_DRAIN_TOKEN = 'hunter2';
      },
      /reference, never a value/,
    ],
    [
      'an ephemeral queue',
      (d) => {
        (spoolService(d).environment as Rec).SHIM_ALLOW_EPHEMERAL_DB = 'true';
      },
      /ephemeral queue/,
    ],
    [
      'an overridden SMTP bind',
      (d) => {
        (spoolService(d).environment as Rec).SMTP_LISTEN_HOST = '0.0.0.0';
      },
      /SMTP listen address/,
    ],
    [
      'no environment',
      (d) => {
        delete spoolService(d).environment;
      },
      /must declare an `environment` map/,
    ],
    [
      'an image on a floating tag',
      (d) => {
        spoolService(d).image = 'ghcr.io/branchleft/mailgun-shim:latest';
      },
      /pinned by digest/,
    ],
    [
      'no image',
      (d) => {
        delete spoolService(d).image;
      },
      /must name its image/,
    ],
    [
      'a host-path mount',
      (d) => {
        (spoolService(d).volumes as string[]).push('/var/run/docker.sock:/var/run/docker.sock');
      },
      /mounts only its own data volume/,
    ],
    [
      'a second service in the stack',
      (d) => {
        (d.services as Rec).sidecar = {};
      },
      /exactly one service/,
    ],
    [
      'running as a tenant uid',
      (d) => {
        spoolService(d).user = '30001:30001';
      },
      /must run as/,
    ],
    [
      'a writable root filesystem',
      (d) => {
        spoolService(d).read_only = false;
      },
      /read_only/,
    ],
    [
      'no init',
      (d) => {
        delete spoolService(d).init;
      },
      /init: true/,
    ],
    [
      'capabilities kept',
      (d) => {
        spoolService(d).cap_drop = [];
      },
      /cap_drop/,
    ],
    [
      'privilege escalation allowed',
      (d) => {
        spoolService(d).security_opt = [];
      },
      /no-new-privileges/,
    ],
    [
      'no pids limit',
      (d) => {
        delete spoolService(d).pids_limit;
      },
      /pids_limit/,
    ],
    [
      'unbounded swap',
      (d) => {
        delete spoolService(d).memswap_limit;
      },
      /memswap_limit/,
    ],
  ];

  it.each(sabotages)('RED: refuses %s', (_label, sabotage, message) => {
    const document = okDocument();
    sabotage(document);
    expect(postureOf(document)).toThrow(message);
  });
});

describe('the posture check guards the renderer itself -- source-mutation sabotage', () => {
  async function sabotagedRender(
    mutate: (source: string) => string
  ): Promise<typeof renderMailSpoolStack> {
    const module = await importSabotaged<{ renderMailSpoolStack: typeof renderMailSpoolStack }>(
      'spool.ts',
      mutate
    );
    return module.renderMailSpoolStack;
  }

  function replaceOrFail(source: string, target: string, replacement: string): string {
    if (!source.includes(target)) {
      throw new Error(`sabotage target not found in spool.ts: ${target}`);
    }
    return source.replace(target, replacement);
  }

  it('RED: a renderer that makes tenant networks non-internal is refused at render time; GREEN: the real one is not', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(s, 'networks[name] = { name, internal: true };', 'networks[name] = { name };')
    );
    expect(() => broken(demoHostArgs())).toThrow(/not `internal: true`/);
    expect(() => renderMailSpoolStack(demoHostArgs())).not.toThrow();
  });

  it('RED: a renderer that drops SHIM_DRAIN_HOST is refused at render time; GREEN: the real one renders it', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(s, 'SHIM_DRAIN_HOST: MAIL_SPOOL_DRAIN_ADDRESS,', '')
    );
    expect(() => broken(demoHostArgs())).toThrow(/must set SHIM_DRAIN_HOST/);
    expect(renderMailSpoolStack(demoHostArgs())).toContain(
      `SHIM_DRAIN_HOST: '${MAIL_SPOOL_DRAIN_ADDRESS}'`
    );
  });

  it('RED: a renderer that writes SHIM_DRAIN_HOST as 0.0.0.0 is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(s, 'SHIM_DRAIN_HOST: MAIL_SPOOL_DRAIN_ADDRESS,', "SHIM_DRAIN_HOST: '0.0.0.0',")
    );
    expect(() => broken(demoHostArgs())).toThrow(/must not be a wildcard address \(0\.0\.0\.0\)/);
  });

  it('RED: a renderer that writes SHIM_DRAIN_HOST as :: is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(s, 'SHIM_DRAIN_HOST: MAIL_SPOOL_DRAIN_ADDRESS,', "SHIM_DRAIN_HOST: '::',")
    );
    expect(() => broken(demoHostArgs())).toThrow(/must not be a wildcard address \(::\)/);
  });

  it('RED: a renderer that drops the drain network ipam is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(
        s,
        'ipam: {\n        config: [{ subnet: MAIL_SPOOL_DRAIN_SUBNET, gateway: MAIL_SPOOL_DRAIN_GATEWAY }],\n      },',
        ''
      )
    );
    expect(() => broken(demoHostArgs())).toThrow(/exactly the ipam pool subnet/);
  });

  it("RED: a renderer that drops the spool's fixed address is refused at render time", async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(
        s,
        '{ ipv4_address: MAIL_SPOOL_DRAIN_ADDRESS }',
        '{ aliases: [MAIL_SPOOL_SERVICE] }'
      )
    );
    expect(() => broken(demoHostArgs())).toThrow(/must set ipv4_address to SHIM_DRAIN_HOST/);
  });

  it('RED: a renderer that publishes the drain port on every address is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(
        s,
        'ports: [drainPublish(args.drainPort)],',
        'ports: [`0.0.0.0:${args.drainPort}:${MAIL_SPOOL_DRAIN_CONTAINER_PORT}`],'
      )
    );
    expect(() => broken(demoHostArgs())).toThrow(/on host loopback only/);
  });

  it('RED: a renderer that leaves /drain on the mail API listener is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(s, 'SHIM_DRAIN_PORT: MAIL_SPOOL_DRAIN_CONTAINER_PORT,', '')
    );
    expect(() => broken(demoHostArgs())).toThrow(/\/drain on the tenant-facing listener/);
    expect(() => renderMailSpoolStack(demoHostArgs())).not.toThrow();
  });

  it('RED: a renderer that publishes the mail API listener as the drain port is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(
        s,
        'ports: [drainPublish(args.drainPort)],',
        'ports: [`127.0.0.1:${args.drainPort}:${MAIL_SPOOL_HTTP_PORT}`],'
      )
    );
    expect(() => broken(demoHostArgs())).toThrow(/publishes exactly one port/);
  });

  it('RED: a renderer that writes the drain token as a value is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(
        s,
        '[MAIL_SPOOL_DRAIN_TOKEN_KEY]:\n            `\\${${MAIL_SPOOL_DRAIN_TOKEN_KEY}:?set ${MAIL_SPOOL_DRAIN_TOKEN_KEY} in ` +\n            `${MAIL_SPOOL_SECRETS_PATH}}`,',
        "[MAIL_SPOOL_DRAIN_TOKEN_KEY]: 'hunter2',"
      )
    );
    expect(() => broken(demoHostArgs())).toThrow(/reference, never a value/);
  });

  it('RED: a renderer that turns masquerade back on is refused at render time', async () => {
    const broken = await sabotagedRender((s) =>
      replaceOrFail(
        s,
        "'com.docker.network.bridge.enable_ip_masquerade': 'false',",
        "'com.docker.network.bridge.enable_ip_masquerade': 'true',"
      )
    );
    expect(() => broken(demoHostArgs())).toThrow(/must disable IP masquerade/);
  });
});
