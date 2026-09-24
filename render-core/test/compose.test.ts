import { describe, expect, it } from 'vitest';
import type { Port, PrivateIpV4, Slug, TenantUid } from '../src/brand.js';
import { GHOST_CONTAINER_PORT, assertRuntimePosture, renderComposeStack } from '../src/compose.js';
import type { YamlValue } from '../src/yaml.js';

const baseArgs = {
  slug: 'acme' as Slug,
  uid: 30123 as TenantUid,
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
};

/** A minimal, posture-compliant service, for building sabotaged variants. */
function okService(): Record<string, YamlValue> {
  return {
    read_only: true,
    init: true,
    user: '30123:30123',
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    pids_limit: 256,
    mem_limit: '640m',
    memswap_limit: '640m',
    cpus: '1.0',
    logging: { options: { 'max-size': '10m', 'max-file': '3' } },
    ports: [`10.20.1.50:3101:${GHOST_CONTAINER_PORT}`],
    healthcheck: {
      test: ['CMD', 'wget', '--header', 'X-Forwarded-Proto: https', 'http://127.0.0.1:2368/'],
    },
    volumes: ['content-vol:/var/lib/ghost/content'],
  };
}

function doc(service: Record<string, YamlValue>): Record<string, YamlValue> {
  return { services: { ghost: service } };
}

describe('renderComposeStack()', () => {
  it('renders two services, ghost-a and ghost-b, on the descriptor ports', () => {
    const yaml = renderComposeStack(baseArgs);
    expect(yaml).toContain('ghost-a:');
    expect(yaml).toContain('ghost-b:');
    expect(yaml).toContain('10.20.1.50:3101:2368');
    expect(yaml).toContain('10.20.1.50:3102:2368');
  });

  it('is a header comment followed by the compose document', () => {
    const yaml = renderComposeStack(baseArgs);
    expect(yaml.startsWith('# The acme Ghost stack')).toBe(true);
  });
});

describe('assertRuntimePosture()', () => {
  it('passes a compliant document', () => {
    expect(() => assertRuntimePosture(doc(okService()), '10.20.1.50')).not.toThrow();
  });

  it('SABOTAGE — appHostPrivateIp of 0.0.0.0 is refused before any port is compared', () => {
    // RED: an unchecked 0.0.0.0 would make every subsequent
    // `parts[0] !== appHostPrivateIp` comparison trivially pass against
    // itself.
    expect(() => assertRuntimePosture(doc(okService()), '0.0.0.0')).toThrow(/private IPv4 range/);
    // GREEN: a real private address passes.
    expect(() => assertRuntimePosture(doc(okService()), '10.20.1.50')).not.toThrow();
  });

  it.each(['privileged', 'cap_add', 'network_mode', 'pid'])(
    'refuses a service declaring `%s`',
    (key) => {
      const service = { ...okService(), [key]: true };
      expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
        new RegExp(`must not set \`${key}\``)
      );
    }
  );

  it('refuses read_only !== true', () => {
    const service = { ...okService(), read_only: false };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(/read_only: true/);
  });

  it('refuses a non-numeric user', () => {
    const service = { ...okService(), user: 'node' };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /numeric per-tenant `user/
    );
  });

  it('refuses a missing cap_drop: [ALL]', () => {
    const service = { ...okService(), cap_drop: [] };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(/cap_drop: \[ALL\]/);
  });

  it('refuses a missing no-new-privileges', () => {
    const service = { ...okService(), security_opt: [] };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /no-new-privileges:true/
    );
  });

  it.each(['seccomp=unconfined', 'apparmor=unconfined', 'systempaths=unconfined'])(
    'refuses opting out of a shipped default (%s)',
    (opt) => {
      const service = { ...okService(), security_opt: ['no-new-privileges:true', opt] };
      expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(/must not opt out/);
    }
  );

  it('refuses a missing pids_limit', () => {
    const { pids_limit: _drop, ...rest } = okService();
    expect(() => assertRuntimePosture(doc(rest), '10.20.1.50')).toThrow(/must set `pids_limit`/);
  });

  it('refuses memswap_limit disagreeing with mem_limit', () => {
    const service = { ...okService(), memswap_limit: '999m' };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /memswap_limit.*equal to.*mem_limit/
    );
  });

  it('refuses a missing cpus', () => {
    const { cpus: _drop, ...rest } = okService();
    expect(() => assertRuntimePosture(doc(rest), '10.20.1.50')).toThrow(/must set `cpus`/);
  });

  it('refuses unbounded json-file logging', () => {
    const service = { ...okService(), logging: { options: {} } };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /bound its json-file logs/
    );
  });

  it('refuses a port not bound to the app host private ip', () => {
    const service = { ...okService(), ports: ['0.0.0.0:3101:2368'] };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(/every port must be/);
  });

  it('refuses a two-part port publish (binds every interface)', () => {
    const service = { ...okService(), ports: ['3101:2368'] };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(/every port must be/);
  });

  it('refuses a non-numeric host port', () => {
    const service = { ...okService(), ports: ['10.20.1.50:not-a-port:2368'] };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /host port is not a number/
    );
  });

  it('refuses a missing healthcheck', () => {
    const { healthcheck: _drop, ...rest } = okService();
    expect(() => assertRuntimePosture(doc(rest), '10.20.1.50')).toThrow(
      /must declare a `healthcheck.test`/
    );
  });

  it('refuses a disabled healthcheck (test: [NONE])', () => {
    const service = { ...okService(), healthcheck: { test: ['NONE'] } };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /must not disable its healthcheck/
    );
  });

  it('refuses a malformed healthcheck.test', () => {
    const service = { ...okService(), healthcheck: { test: 42 } };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /not a string, `CMD` or `CMD-SHELL`/
    );
  });

  it('refuses a healthcheck.test array of non-strings', () => {
    const service = { ...okService(), healthcheck: { test: ['CMD', 1] } };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /not a string, `CMD` or `CMD-SHELL`/
    );
  });

  it('accepts a CMD-SHELL healthcheck carrying the forwarded-proto header', () => {
    const service = {
      ...okService(),
      healthcheck: { test: 'CMD-SHELL wget --header "X-Forwarded-Proto: https" http://x' },
    };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).not.toThrow();
  });

  it('SABOTAGE — a healthcheck that never sends X-Forwarded-Proto is refused, real header restores green', () => {
    // RED: dropping `--header X-Forwarded-Proto: https` from the CMD form —
    // the exact regression `infra/tenant/compose.ts`'s own comment warns
    // about (Ghost 301-redirects the probe to HTTPS, which `wget` cannot
    // follow, forever).
    const broken = {
      ...okService(),
      healthcheck: { test: ['CMD', 'wget', 'http://127.0.0.1:2368/'] },
    };
    expect(() => assertRuntimePosture(doc(broken), '10.20.1.50')).toThrow(
      /must bind .*X-Forwarded-Proto: https.* to `--header`/
    );
    // GREEN: the real render always includes it — see renderComposeStack's
    // own test above and the golden fixtures.
    expect(() => assertRuntimePosture(doc(okService()), '10.20.1.50')).not.toThrow();
  });

  it('refuses a host-path volume mount', () => {
    const service = { ...okService(), volumes: ['/etc/passwd:/x'] };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(/only named volumes/);
  });

  it('refuses a Docker socket mount', () => {
    const service = { ...okService(), volumes: ['sock-vol:/var/run/docker.sock'] };
    expect(() => assertRuntimePosture(doc(service), '10.20.1.50')).toThrow(
      /must never receive the Docker socket/
    );
  });
});
