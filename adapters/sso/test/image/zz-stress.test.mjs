// THROWAWAY diagnostic for branchLeft/workspace#2730. Never merged.
// Repeats the exact shape of GhostContainer.start (sync docker create and
// start, then the first await is a fetch) against the built image, with
// `--entrypoint sleep` so there is no Ghost boot and no registry pull.
// A round is a describe+before so a lost promise would show as the same
// "Promise resolution is still pending" cancellation as production.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const IMAGE = process.env.IMAGE;
if (!IMAGE) throw new Error('IMAGE must name the built Ghost image');
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 200);
const VARIANTS = ['fetch-localhost', 'fetch-127', 'http-request'];

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probe(variant, port) {
  if (variant === 'fetch-localhost') return fetch(`http://localhost:${port}/`).then((r) => r.status);
  if (variant === 'fetch-127') return fetch(`http://127.0.0.1:${port}/`).then((r) => r.status);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once('error', reject);
  });
}

for (let round = 0; round < ROUNDS; round += 1) {
  const variant = VARIANTS[round % VARIANTS.length];
  describe(`stress round ${round} (${variant})`, { timeout: 60_000 }, () => {
    let name;
    let outcomes;
    before(async () => {
      const port = await freePort();
      name = `zz-stress-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      docker('create', '--name', name, '--entrypoint', 'sleep', '-p', `127.0.0.1:${port}:2368`, IMAGE, '600');
      docker('start', name);
      outcomes = [];
      for (let i = 0; i < 4; i += 1) {
        try {
          outcomes.push(await probe(variant, port));
        } catch (err) {
          outcomes.push(String(err.cause?.code ?? err.code ?? err.message));
        }
        docker('inspect', '-f', '{{.State.Running}}', name);
        await sleep(100);
      }
    });
    after(() => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }));
    it('round completed', () => {
      assert.equal(outcomes.length, 4);
    });
  });
}
