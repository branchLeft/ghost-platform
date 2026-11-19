import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMemoryShard, type MemoryShard } from './support/memory-shard.js';
import { startRecordingEdge, type RecordingEdge } from './support/recording-edge.js';
import { STATE_BUCKET, nextPrefix, startStateRig, type StateRig } from './support/state-rig.js';
import type { Minted } from './support/gateway-rig.js';

const have = (command: string, args: string[]): boolean =>
  spawnSync(command, args, { stdio: 'ignore' }).status === 0;
const runnable = have('pulumi', ['version']) && have('openssl', ['version']);

/**
 * The recording probe: the pinned Pulumi CLI, as installed here, against a
 * real state process and a recording stand-in for the edge, over TLS, on
 * loopback. It writes nothing outside a temporary directory and reaches no
 * network. Skipped where the CLI is not installed.
 */
describe.skipIf(!runnable)('the Pulumi CLI against the state process', () => {
  let work: string;
  let rig: StateRig;
  let shard: MemoryShard;
  let edge: RecordingEdge;
  let tenant: Minted;
  let env: Record<string, string>;
  const logs: string[] = [];

  // Asynchronous on purpose: the stand-in for the edge lives in this process and must keep answering.
  const pulumi = (...args: string[]): Promise<{ status: number; text: string }> =>
    new Promise((resolve) => {
      const child = spawn('pulumi', [...args, '--non-interactive'], {
        cwd: join(work, 'program'),
        env,
      });
      let text = '';
      child.stdout.on('data', (c: Buffer) => (text += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (text += c.toString('utf8')));
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        logs.push(`$ pulumi ${args.join(' ')} -> ${String(code)}\n${text}`);
        resolve({ status: code ?? -1, text });
      });
    });

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'gw-pulumi-'));
    await mkdir(join(work, 'program'));
    await mkdir(join(work, 'home'));
    await writeFile(join(work, 'program', 'Pulumi.yaml'), 'name: probe\nruntime: yaml\n');
    shard = await startMemoryShard(STATE_BUCKET);
    rig = await startStateRig({ env: { STORAGE_GATEWAY_UPSTREAM_ENDPOINT: shard.origin } });
    tenant = await rig.mint(nextPrefix());
    edge = await startRecordingEdge(work, { port: rig.port }, STATE_BUCKET, tenant.folder);
    env = {
      PATH: process.env.PATH ?? '',
      HOME: work,
      USER: 'probe',
      PULUMI_HOME: join(work, 'home'),
      PULUMI_CONFIG_PASSPHRASE: 'recording-probe',
      PULUMI_SKIP_UPDATE_CHECK: 'true',
      PULUMI_SKIP_CONFIRMATIONS: 'true',
      PULUMI_DISABLE_CI_DETECTION: 'true',
      // The AWS SDK's own setting: Go on macOS ignores SSL_CERT_FILE.
      AWS_CA_BUNDLE: edge.certFile,
      SSL_CERT_FILE: edge.certFile,
      AWS_ACCESS_KEY_ID: tenant.keyId,
      AWS_SECRET_ACCESS_KEY: tenant.secret,
      AWS_REGION: 'nbg1',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    };
  }, 60_000);

  afterAll(async () => {
    if (process.env.STATE_PROBE_VERBOSE === '1') {
      console.log(logs.join('\n'));
      console.log(edge?.shapes.map((x) => JSON.stringify(x)).join('\n'));
      console.log(rig?.refusals().join(','));
    }
    await edge?.close();
    await rig?.stop();
    await shard?.close();
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  });

  it('logs in, creates a stack and previews, inside its own prefix', async () => {
    const backend = `s3://${STATE_BUCKET}/${tenant.folder}?endpoint=127.0.0.1:${String(edge.port)}&s3ForcePathStyle=true&region=nbg1`;
    // An update writes a stack, so it runs only when a person asks for it, and then only
    // against the loopback stand-in for the shard that this file starts.
    const steps = [['login', backend], ['stack', 'init', 'probe'], ['preview']];
    if (process.env.STATE_PROBE_UP === '1') {
      steps.push(['up', '--yes'], ['up', '--yes'], ['refresh', '--yes']);
    }
    for (const args of steps) {
      const result = await pulumi(...args);
      expect(result.status, `pulumi ${args[0]}: ${result.text.slice(-600)}`).toBe(0);
    }
    expect(shard.keys().length).toBeGreaterThan(0);
    for (const key of shard.keys()) expect(key.startsWith(`${tenant.folder}/`)).toBe(true);
  }, 240_000);

  it('records the request set the allowlist is built from, and every delete it saw', () => {
    const table = new Map<string, number>();
    for (const s of edge.shapes) {
      const row = `${s.method} ${s.path} ?${s.query.join(',')} payload=${s.payload} [${s.notable.join(',')}] -> ${String(s.status)}`;
      table.set(row, (table.get(row) ?? 0) + 1);
    }
    console.log([...table].map(([row, n]) => `${String(n).padStart(3)} x ${row}`).join('\n'));
    console.log(rig.refusals().join(','));
    // Nothing the CLI does in these runs deletes anything but a lock.
    const deletes = edge.shapes.filter((x) => x.method === 'DELETE');
    for (const d of deletes) expect(d.path).toContain('/.pulumi/locks/');
    expect(rig.refusals()).toEqual([]);
  });
});
