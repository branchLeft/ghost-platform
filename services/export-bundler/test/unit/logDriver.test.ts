import { describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  buildRelayRunArgs,
  NO_CONTAINER_LOGS,
  type TenantColourSpec,
} from '../../src/containerRunner.js';
import {
  buildDumpArgs,
  buildScratchMysqlRunArgs,
  buildSqliteBackupArgs,
} from '../../src/scratchDatabase.js';
import { buildStatusProbeArgs } from '../../src/supportAccountProbe.js';

/** The log driver a `docker run` argv selects, or null for the daemon default. */
function logDriverOf(argv: readonly string[]): string | null {
  const i = argv.indexOf('--log-driver');
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

const colour: TenantColourSpec = {
  containerName: 'acme-export-42',
  image: 'ghost-platform@sha256:abc',
  loopbackPort: 4400,
  envFile: '/tmp/e/tenant.env',
  user: '1001:1001',
  volumes: [{ volume: 'ghost-acme-content', mountPath: '/var/lib/ghost/content' }],
  network: 'acme-export-42-net',
};

/**
 * Every `docker run` in an export whose stdout or stderr can carry tenant
 * data: Docker's default json-file driver would write that output,
 * uncapped, to /var/lib/docker. The dump is the case that matters most --
 * its stdout is the whole database.
 */
const DATA_HANDLING_RUNS: ReadonlyArray<[string, readonly string[]]> = [
  [
    'the mysqldump of the live database',
    buildDumpArgs(
      {
        runId: 'acme-export-42',
        live: { kind: 'mysql', host: '10.0.0.5', port: 3306, database: 'ghost_acme' },
        liveUser: 'ghost_acme',
        livePassword: 'x',
        liveUsesTls: true,
      },
      '/tmp/e/tenant.env'
    ),
  ],
  [
    'the scratch MySQL the dump is restored into',
    buildScratchMysqlRunArgs('acme-export-42', '/tmp/e'),
  ],
  [
    'the SQLite online backup',
    buildSqliteBackupArgs({
      runId: 'acme-export-42',
      image: 'ghost-platform@sha256:abc',
      tenantVolumes: colour.volumes,
      live: { kind: 'sqlite', filename: '/var/lib/ghost/content/data/ghost.db' },
      owner: '1001:1001',
    }),
  ],
  ['the support-account status probe', buildStatusProbeArgs(colour, 'support@acme.example')],
  ['the export colour on the run network', buildDockerRunArgs(colour)],
  ['the export colour without a network', buildDockerRunArgs({ ...colour, network: null })],
  ['the loopback relay', buildRelayRunArgs(colour)],
];

describe('--log-driver none', () => {
  it('is what NO_CONTAINER_LOGS says', () => {
    expect(NO_CONTAINER_LOGS).toEqual(['--log-driver', 'none']);
  });

  it.each(DATA_HANDLING_RUNS)('is set on %s', (_label, argv) => {
    expect(argv[0]).toBe('run');
    expect(logDriverOf(argv)).toBe('none');
    // Before the image: after it, docker would pass the flag to the container.
    const image = argv.findIndex(
      (a) => a.startsWith('ghost-platform') || a.startsWith('mysql:8.0@')
    );
    expect(argv.indexOf('--log-driver')).toBeLessThan(image);
  });
});
