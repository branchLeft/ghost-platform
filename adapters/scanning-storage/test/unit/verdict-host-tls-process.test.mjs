// The whole host end process with TLS configured through its environment, as
// a supervisor would start it: the guard is installed, the READY line carries
// the pin, and a refused identity stops the start without printing the key.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freePort } from '../helpers/verdict-host-process.mjs';
import { makeKeys, newTempDir, signHeaders } from '../helpers/verdict-host-rig.mjs';
import { tlsRequest } from '../helpers/verdict-host-tls-client.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const directories = [];
const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    // A child stopped by a signal has a null exitCode but has already exited:
    // waiting for an 'exit' event then would never end.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

async function setup(extraEnv = {}) {
  const directory = newTempDir();
  directories.push(directory);
  const keys = makeKeys(directory);
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    VERDICT_HOST_SOCKET: path.join(directory, 'v.sock'),
    VERDICT_HOST_JOURNAL: path.join(directory, 'state', 'queue.journal'),
    VERDICT_HOST_VERIFY_KEY_FILE: keys.keyFile,
    VERDICT_HOST_METRICS_FILE: path.join(directory, 'metrics', 'vh.prom'),
    VERDICT_HOST_INBOUND_PORT: String(port),
    VERDICT_HOST_INBOUND_HOST: '127.0.0.1',
    VERDICT_HOST_HOLD_MS: '100',
    ...extraEnv,
  };
  return { directory, keys, port, env };
}

function run(env) {
  const child = spawn(process.execPath, [path.join(root, 'verdict-host/main.js')], {
    env,
    cwd: root,
  });
  children.push(child);
  const process_ = { output: '', exited: null };
  child.stdout.on('data', (chunk) => (process_.output += chunk));
  child.stderr.on('data', (chunk) => (process_.output += chunk));
  child.on('exit', (code) => {
    process_.exited = code;
  });
  process_.child = child;
  return process_;
}

async function untilReadyOrExit(running) {
  for (let waited = 0; waited < 8000; waited += 20) {
    if (running.output.includes('VERDICT_HOST_READY') || running.exited !== null) return;
    await wait(20);
  }
  throw new Error(`the host end neither started nor stopped: ${running.output}`);
}

const tlsEnv = (directory) => ({
  VERDICT_HOST_INBOUND_TLS: 'pinned-private',
  VERDICT_HOST_TLS_CERT_FILE: path.join(directory, 'tls.crt'),
  VERDICT_HOST_TLS_KEY_FILE: path.join(directory, 'tls.key'),
});

async function stop(running) {
  running.child.kill('SIGTERM');
  await new Promise((resolve) =>
    running.exited !== null ? resolve() : running.child.once('exit', resolve)
  );
}

describe('the host end process with TLS', () => {
  it('prints its pin in the READY line, and the pin is the one a client sees', async () => {
    const { directory, keys, port, env } = await setup();
    const running = run({ ...env, ...tlsEnv(directory) });
    await untilReadyOrExit(running);
    const ready = running.output.split('\n').find((line) => line.startsWith('VERDICT_HOST_READY'));
    const match = /^VERDICT_HOST_READY inbound=127\.0\.0\.1:\d+ tls_pin=([0-9a-f]{64})$/.exec(
      ready
    );
    expect(match, ready).not.toBeNull();

    const headers = signHeaders(keys.privateKey, 'GET', '/safety/v1/pending', '', {
      now: Date.now() + 3000,
    });
    const answer = await tlsRequest({
      port,
      path: '/safety/v1/pending',
      headers,
      certFile: path.join(directory, 'tls.crt'),
      pin: match[1],
    });
    expect(answer.status).toBe(200);
    expect(answer.pin).toBe(match[1]);
    await stop(running);
    expect(running.output).not.toMatch(/EGRESS_REFUSED|never dials out/);
    const metrics = fs.readFileSync(env.VERDICT_HOST_METRICS_FILE, 'utf8');
    expect(metrics).toContain('verdict_host_egress_refused_total 0');
  }, 20_000);

  it('prints the same pin after a restart, and nothing else about the identity', async () => {
    const { directory, env } = await setup();
    const first = run({ ...env, ...tlsEnv(directory) });
    await untilReadyOrExit(first);
    await stop(first);
    const second = run({ ...env, ...tlsEnv(directory) });
    await untilReadyOrExit(second);
    await stop(second);
    const pinOf = (running) => /tls_pin=([0-9a-f]{64})/.exec(running.output)?.[1];
    expect(pinOf(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(pinOf(second)).toBe(pinOf(first));
    const key = fs.readFileSync(path.join(directory, 'tls.key'), 'utf8');
    const body = key.split('\n').filter((line) => line && !line.startsWith('-----'));
    for (const line of body) expect(first.output + second.output).not.toContain(line);
    const pemBeginMarker = ['BE', 'GIN'].join('');
    expect(first.output).not.toContain(pemBeginMarker);
  }, 20_000);

  it('has no pin in the READY line, and plain HTTP, when TLS is not configured', async () => {
    const { env } = await setup();
    const running = run(env);
    await untilReadyOrExit(running);
    await stop(running);
    expect(running.output).toMatch(/VERDICT_HOST_READY inbound=127\.0\.0\.1:\d+\n/);
    expect(running.output).not.toContain('tls_pin');
  }, 20_000);

  it('refuses to start on a key others can read, without printing the key', async () => {
    const { directory, env } = await setup();
    const first = run({ ...env, ...tlsEnv(directory) });
    await untilReadyOrExit(first);
    await stop(first);
    const keyFile = path.join(directory, 'tls.key');
    fs.chmodSync(keyFile, 0o644);
    const second = run({ ...env, ...tlsEnv(directory) });
    await untilReadyOrExit(second);
    await new Promise((resolve) =>
      second.exited !== null ? resolve() : second.child.once('exit', resolve)
    );
    expect(second.exited).toBe(1);
    expect(second.output).toContain('VERDICT_HOST_START_FAILED');
    expect(second.output).toContain(keyFile);
    expect(second.output).not.toContain('VERDICT_HOST_READY');
    const body = fs.readFileSync(keyFile, 'utf8').split('\n')[1];
    expect(second.output).not.toContain(body);
  }, 20_000);

  it.each([
    ['the mode with no paths', () => ({ VERDICT_HOST_INBOUND_TLS: 'pinned-private' })],
    ['one path only', () => ({ VERDICT_HOST_TLS_CERT_FILE: '/tmp/vh-only.crt' })],
    [
      'a wildcard address',
      (directory) => ({ ...tlsEnv(directory), VERDICT_HOST_INBOUND_HOST: '0.0.0.0' }),
    ],
  ])(
    'refuses to start with %s, and listens on nothing',
    async (_name, makeChange) => {
      const { directory, env } = await setup();
      const running = run({ ...env, ...makeChange(directory) });
      await untilReadyOrExit(running);
      await new Promise((resolve) =>
        running.exited !== null ? resolve() : running.child.once('exit', resolve)
      );
      expect(running.exited).toBe(1);
      expect(running.output).toContain('VERDICT_HOST_START_FAILED');
      expect(running.output).not.toContain('VERDICT_HOST_READY');
    },
    20_000
  );
});
