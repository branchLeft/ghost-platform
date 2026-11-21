import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_CLEANUP_FAILED,
  exitCodeFor,
  failureLines,
  main,
  parseArgs,
  reportExport,
} from '../../src/cli.js';
import { ExportCleanupError, type ExportResult } from '../../src/exportRunner.js';
import { DockerEngineTooOldError } from '../../src/containerRunner.js';
import {
  RecipientMismatchError,
  SUPPORT_IDENTITY_ENV,
  TenantConfigError,
} from '../../src/tenantConfig.js';
import { writeFakeDocker } from '../helpers/fakeDocker.js';

/**
 * The call site of the Docker engine gate. The gate itself is unit-tested in
 * containerRunner.test.ts; this file proves main() makes the call, and makes
 * it before anything that creates a resource -- which no other test can,
 * since cli.ts is not covered. Delete the `startup` call from main() and the
 * 27.x case below fails: main() goes on to the descriptor instead of refusing.
 */
describe('main: the Docker engine gate runs first', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A complete, valid flag set; the descriptor does not exist, so a run that passes the gate stops there. */
  function argv(): string[] {
    return [
      '--grant-lane',
      'consented',
      '--grant-reference',
      'test-reference',
      '--descriptor',
      join(dir, 'no-such-descriptor.json'),
      '--age-recipient',
      'age1testrecipient',
      '--requested-by',
      'tester',
      '--delivered-to',
      'tester',
      '--dest-dir',
      join(dir, 'dest'),
      '--flag-dir',
      join(dir, 'flags'),
      '--audit-log',
      join(dir, 'audit.log'),
      '--loopback-port',
      '4400',
      '--erasure-date',
      '2030-01-01',
    ];
  }

  async function calls(argvLog: string): Promise<string[][]> {
    const text = await readFile(argvLog, 'utf8').catch(() => '');
    return text
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as string[]);
  }

  it('refuses a 27.x engine before any docker run, create, network, volume or compose call', async () => {
    const argvLog = join(dir, 'argv.log');
    const fake = await writeFakeDocker(dir, { argvLogPath: argvLog, versionOutput: '27.5.1' });

    await expect(
      main(argv(), { dockerCommand: fake, signalTarget: new EventEmitter() as never })
    ).rejects.toThrow(DockerEngineTooOldError);

    const verbs = (await calls(argvLog)).map((c) => c[0]);
    expect(verbs).toEqual(['version']);
    for (const forbidden of ['run', 'create', 'network', 'volume', 'compose']) {
      expect(verbs).not.toContain(forbidden);
    }
  });

  it('lets a 28.0.0 engine through to the descriptor, after exactly one version call', async () => {
    const argvLog = join(dir, 'argv.log');
    const fake = await writeFakeDocker(dir, { argvLogPath: argvLog, versionOutput: '28.0.0' });

    await expect(
      main(argv(), { dockerCommand: fake, signalTarget: new EventEmitter() as never })
    ).rejects.toThrow(TenantConfigError);

    expect((await calls(argvLog)).map((c) => c[0])).toEqual(['version']);
  });

  it('refuses before the flags are read: a missing grant on a 27.x engine is still an engine refusal', async () => {
    const fake = await writeFakeDocker(dir, { versionOutput: '27.5.1' });
    await expect(
      main([], { dockerCommand: fake, signalTarget: new EventEmitter() as never })
    ).rejects.toThrow(DockerEngineTooOldError);
  });

  it('installs the signal handlers on the target it is given, and not on process', async () => {
    const fake = await writeFakeDocker(dir, { versionOutput: '28.0.0' });
    const target = new EventEmitter();
    const before = process.listenerCount('SIGINT');
    await main(argv(), { dockerCommand: fake, signalTarget: target as never }).catch(
      () => undefined
    );
    expect(target.listenerCount('SIGINT')).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('reportExport and the failure lines', () => {
  const result: ExportResult = {
    archivePath: '/dest/t-export.tar.age',
    manifestPath: '/dest/t-export.manifest.json',
    archiveSha256: 'a'.repeat(64),
    manifest: { complete: true } as ExportResult['manifest'],
  };

  it('prints path, sha256, manifest and completeness, and returns, when teardown was clean', () => {
    const out: string[] = [];
    reportExport(result, (l) => out.push(l));
    expect(out).toEqual([
      'export-bundler: wrote /dest/t-export.tar.age',
      `export-bundler: sha256 ${'a'.repeat(64)}`,
      'export-bundler: manifest /dest/t-export.manifest.json',
      'export-bundler: complete true',
    ]);
  });

  it('prints the whole result first, then raises ExportCleanupError naming the teardown failure', () => {
    const out: string[] = [];
    const cleanupErrors = [new Error('docker volume rm: volume is in use')];
    let raised: unknown;
    try {
      reportExport({ ...result, cleanupErrors }, (l) => out.push(l));
    } catch (err) {
      raised = err;
    }
    expect(out).toHaveLength(4);
    expect(out[1]).toBe(`export-bundler: sha256 ${'a'.repeat(64)}`);
    expect(raised).toBeInstanceOf(ExportCleanupError);
    expect((raised as ExportCleanupError).cleanupErrors).toBe(cleanupErrors);
    expect(failureLines(raised)).toEqual([
      'export-bundler: ExportCleanupError: the export succeeded but a cleanup step failed ' +
        '(Error: docker volume rm: volume is in use)',
    ]);
    expect(exitCodeFor(raised)).toBe(EXIT_CLEANUP_FAILED);
  });

  it('a failed export keeps its own error first, then names the teardown failures; exit 1', () => {
    const err = new Error('export sabotage failure');
    Object.defineProperty(err, 'cleanupErrors', { value: [new Error('network rm refused')] });
    expect(failureLines(err)).toEqual([
      'export-bundler: Error: export sabotage failure',
      'export-bundler: and then a cleanup step failed (Error: network rm refused)',
    ]);
    expect(exitCodeFor(err)).toBe(1);
  });

  it('a failed export with clean teardown prints one line', () => {
    expect(failureLines(new Error('boom'))).toEqual(['export-bundler: Error: boom']);
  });
});

describe('parseArgs: the media flags', () => {
  const base = [
    '--grant-lane',
    'consented',
    '--grant-reference',
    'ref',
    '--descriptor',
    'd.json',
    '--age-recipient',
    'age1x',
    '--requested-by',
    'a',
    '--delivered-to',
    'b',
    '--dest-dir',
    '/d',
    '--flag-dir',
    '/f',
    '--audit-log',
    '/a',
    '--loopback-port',
    '1',
    '--erasure-date',
    '2030-01-01',
  ];

  it('carries no media files by default, with the 128 MiB upload ceiling', () => {
    const opts = parseArgs(base);
    expect(opts.carryMediaFiles).toBe(false);
    expect(opts.uploadCeilingBytes).toBe(128 * 1024 * 1024);
  });

  it('carries them only when asked, with the ceiling the destination tier states', () => {
    const opts = parseArgs([...base, '--carry-media-files', '--upload-ceiling-bytes', '5000']);
    expect(opts.carryMediaFiles).toBe(true);
    expect(opts.uploadCeilingBytes).toBe(5000);
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['']])('refuses the upload ceiling %j', (value) => {
    expect(() => parseArgs([...base, '--upload-ceiling-bytes', value])).toThrow(/positive whole/);
  });
});

const PROMOTION = 'age1' + 'q'.repeat(58);
const OTHER = 'age1' + 'p'.repeat(58);

const BASE_FLAGS = [
  '--grant-lane',
  'consented',
  '--grant-reference',
  'test-reference',
  '--descriptor',
  '/nonexistent/descriptor.json',
  '--age-recipient',
  PROMOTION,
  '--requested-by',
  'tester',
  '--delivered-to',
  'tester',
  '--dest-dir',
  '/nonexistent/dest',
  '--flag-dir',
  '/nonexistent/flags',
  '--audit-log',
  '/nonexistent/audit.log',
  '--loopback-port',
  '4400',
  '--erasure-date',
  '2030-01-01',
];

describe('parseArgs: --promotion-recipient', () => {
  it('is absent unless given', () => {
    expect(parseArgs(BASE_FLAGS).promotionRecipient).toBeUndefined();
  });

  it('is read when given', () => {
    expect(parseArgs([...BASE_FLAGS, '--promotion-recipient', PROMOTION]).promotionRecipient).toBe(
      PROMOTION
    );
  });

  it.each([
    ['with no value at the end', ['--promotion-recipient']],
    ['followed by another flag', ['--promotion-recipient', '--erasure-date', '2031-01-01']],
  ])('is refused %s, never read as absent', (_label, extra) => {
    expect(() => parseArgs([...BASE_FLAGS, ...extra])).toThrow(TenantConfigError);
  });
});

/**
 * main() reads the flag and hands it, with the grant's lane, to bindTenant.
 * A fake `docker` answers the engine version and the compose config of a
 * demo, so each run reaches the binding and stops there, before any
 * container, volume or network call. Delete the promotion argument from
 * main()'s bindTenant call and the first three cases fail: the recipient
 * is then refused for the wrong reason, or not at all.
 */
describe('main: a demo export binds its recipient before anything is created', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-cli-promotion-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function demoDocker(): Promise<{ docker: string; argvLog: string; flags: string[] }> {
    const compose = {
      name: 'demo-one',
      services: {
        'ghost-a': {
          image: 'ghost-platform@sha256:abc',
          environment: {
            adapters__sso__BreakGlassSSO__tenant: 'demo-one',
            [SUPPORT_IDENTITY_ENV]: 'support@demo-one.example',
          },
          volumes: [{ type: 'volume', source: 'ghost-demo-one-content', target: '/content' }],
        },
      },
    };
    const descriptorPath = join(dir, 'descriptor.json');
    await writeFile(descriptorPath, JSON.stringify({ slug: 'demo-one', backup: { kind: 'none' } }));
    const composePath = join(dir, 'compose.json');
    await writeFile(composePath, JSON.stringify(compose));
    const argvLog = join(dir, 'argv.log');
    const docker = join(dir, 'docker-demo.sh');
    await writeFile(
      docker,
      [
        '#!/bin/sh',
        `printf '%s\n' "$1" >> '${argvLog}'`,
        `if [ "$1" = version ]; then echo 28.0.0; exit 0; fi`,
        `if [ "$1" = compose ]; then cat '${composePath}'; exit 0; fi`,
        'exit 0',
        '',
      ].join('\n')
    );
    await chmod(docker, 0o755);
    const flags = BASE_FLAGS.map((f) =>
      f === '/nonexistent/descriptor.json' ? descriptorPath : f
    );
    return { docker, argvLog, flags };
  }

  async function verbs(argvLog: string): Promise<string[]> {
    return (await readFile(argvLog, 'utf8')).trim().split('\n');
  }

  const run = (docker: string, argv: string[]) =>
    main(argv, { dockerCommand: docker, signalTarget: new EventEmitter() as never });

  it('refuses a demo with no promotion recipient, after the compose read and before anything else', async () => {
    const { docker, argvLog, flags } = await demoDocker();
    await expect(run(docker, flags)).rejects.toThrow(/no promotion recipient/);
    expect(await verbs(argvLog)).toEqual(['version', 'compose']);
  });

  it("refuses an operator recipient that is not the promotion's", async () => {
    const { docker, argvLog, flags } = await demoDocker();
    const argv = flags.map((f) => (f === PROMOTION ? OTHER : f));
    await expect(run(docker, [...argv, '--promotion-recipient', PROMOTION])).rejects.toThrow(
      RecipientMismatchError
    );
    expect(await verbs(argvLog)).toEqual(['version', 'compose']);
  });

  it('refuses a promotion recipient under the incident lane', async () => {
    const { docker, argvLog, flags } = await demoDocker();
    const argv = flags.map((f) => (f === 'consented' ? 'incident' : f));
    await expect(run(docker, [...argv, '--promotion-recipient', PROMOTION])).rejects.toThrow(
      /only under a consented support grant/
    );
    expect(await verbs(argvLog)).toEqual(['version', 'compose']);
  });

  it('accepts a matching promotion recipient under the consented lane: the run goes past the binding', async () => {
    const { docker, flags } = await demoDocker();
    const raised = await run(docker, [...flags, '--promotion-recipient', PROMOTION]).then(
      () => undefined,
      (err: unknown) => err
    );
    // The stack has no database configured, so the run stops later, for that
    // reason; what matters is that it is not a refusal of the recipient.
    expect((raised as Error | undefined)?.message ?? '').not.toMatch(/recipient/i);
    expect(raised).not.toBeInstanceOf(RecipientMismatchError);
  });
});
