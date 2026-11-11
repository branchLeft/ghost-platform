// Runs a host end as its own process, drives one full round through it from
// outside (an ask on the local socket, a poll and a verdict post as the
// service), and reports any sign that it dialled out. The canary is a TCP
// listener the process has no reason to reach.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hashOf, makeKeys, newTempDir, signHeaders, verdictFor } from './verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const { ProductionVerdictClient } = require('../../src/production-verdict-client');
const { createSocketVerdictTransport } = require('../../src/socket-verdict-transport');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = path.resolve(import.meta.dirname, '../..');

export async function startCanary() {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket.remoteAddress);
    socket.on('error', () => {});
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    connections,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Returns { violations, answer } where violations is empty only if the process
// stayed up, the canary saw nothing, and the process printed no refusal.
export async function runOneRound({ entry, args = [], canary }) {
  const directory = newTempDir();
  const keys = makeKeys(directory);
  const inboundPort = await freePort();
  const socketPath = path.join(directory, 'v.sock');
  const env = {
    PATH: process.env.PATH,
    VERDICT_HOST_SOCKET: socketPath,
    VERDICT_HOST_JOURNAL: path.join(directory, 'state', 'queue.journal'),
    VERDICT_HOST_VERIFY_KEY_FILE: keys.keyFile,
    VERDICT_HOST_METRICS_FILE: path.join(directory, 'metrics', 'vh.prom'),
    VERDICT_HOST_INBOUND_PORT: String(inboundPort),
    VERDICT_HOST_HOLD_MS: '200',
    VERDICT_HOST_ASK_WAIT_MS: '3000',
    CANARY_PORT: String(canary.port),
  };
  const child = spawn(process.execPath, [path.join(root, entry), ...args], { env, cwd: root });
  let output = '';
  let exited = null;
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.on('exit', (code) => {
    exited = code;
  });

  const violations = [];
  let answer = null;
  try {
    for (let waited = 0; !output.includes('VERDICT_HOST_READY') && exited === null; waited += 20) {
      if (waited > 5000) throw new Error('the host end did not start');
      await wait(20);
    }
    // The decorator's side, over the real transport.
    const client = new ProductionVerdictClient({
      transport: createSocketVerdictTransport({ socketPath }),
      connectTimeoutMs: 1000,
      totalTimeoutMs: 4000,
    });
    const asking = client.getVerdict(hashOf(5));

    // The service's side, dialling in. The request time is a few seconds
    // ahead, inside the allowed skew, to clear the process-start floor.
    const call = (method, url, body = '') =>
      fetch(`http://127.0.0.1:${inboundPort}${url}`, {
        method,
        headers: signHeaders(keys.privateKey, method, url, body, { now: Date.now() + 3000 }),
        body: method === 'GET' ? undefined : body,
      });
    let batch = { hashes: [] };
    for (let attempt = 0; attempt < 5 && batch.hashes.length === 0; attempt += 1) {
      batch = await (await call('GET', '/safety/v1/pending')).json();
    }
    if (batch.hashes.length === 1) {
      const body = JSON.stringify({
        v: 1,
        batch: batch.batch,
        verdicts: [verdictFor(batch.hashes[0])],
      });
      await call('POST', '/safety/v1/verdicts', body);
    }
    answer = await asking;
    await wait(100);
  } catch (err) {
    violations.push(`round failed: ${err.message}`);
  }
  if (exited !== null) violations.push(`the process exited with ${exited}`);
  if (/EGRESS_REFUSED|never dials out/.test(output)) violations.push('the guard refused a dial');
  if (canary.connections.length > 0) violations.push('the canary received a connection');

  child.kill('SIGTERM');
  await new Promise((resolve) => (exited !== null ? resolve() : child.once('exit', resolve)));
  fs.rmSync(directory, { recursive: true, force: true });
  return { violations, answer, output };
}
