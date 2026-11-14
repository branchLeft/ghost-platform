// The host end never dials out. Three independent proofs, because no single
// one is enough: no code that dials (a scan of what the process loads), a
// guard that refuses a dial at the point Node makes it, and a run of the whole
// process beside a canary listener, with two deliberately wrong variants that
// the same run must flag. The OS-level confinement of the unit is the fourth
// layer and is not provable in a unit test (verdict-host.md).
import { afterEach, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { startCanary, runOneRound } from '../helpers/verdict-host-process.mjs';

const require = createRequire(import.meta.url);
const { installNoEgress, EgressRefusedError } = require('../../verdict-host/egress-guard');

const root = path.resolve(import.meta.dirname, '../..');

// ---- 1. No code that dials ------------------------------------------------

const ALLOWED_BUILTINS = new Set(['crypto', 'events', 'fs', 'http', 'net', 'os', 'path']);
// Only the guard may name the modules it patches.
const GUARD_ONLY_BUILTINS = new Set(['dgram', 'dns', 'net']);
const NET_ALLOWED_MEMBERS = new Set(['createServer', 'isIPv4']);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export function dialFindings(file, source) {
  const code = stripComments(source);
  const findings = [];
  const isGuard = path.basename(file) === 'egress-guard.js';
  for (const match of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = match[1];
    if (target.startsWith('.')) continue;
    const name = target.replace(/^node:/, '');
    if (!ALLOWED_BUILTINS.has(name) && !(isGuard && GUARD_ONLY_BUILTINS.has(name))) {
      findings.push(`requires ${target}`);
    }
  }
  if (!isGuard) {
    for (const match of code.matchAll(/\bnet\.(\w+)/g)) {
      if (!NET_ALLOWED_MEMBERS.has(match[1])) findings.push(`uses net.${match[1]}`);
    }
    if (/\bnet\s*\.\s*Socket\b|new\s+Socket\b/.test(code)) findings.push('makes a Socket by hand');
  }
  if (/\.\s*connect\s*\(/.test(code) && !isGuard) findings.push('calls connect()');
  if (
    /createConnection|\bhttp\s*\.\s*(request|get|Agent)\b|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/.test(
      code
    )
  ) {
    findings.push('names a client API');
  }
  if (/child_process|worker_threads|process\.binding|\beval\s*\(|new\s+Function\b/.test(code)) {
    findings.push('names a way around the guard');
  }
  return findings;
}

function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of stripComments(source).matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      queue.push(/\.c?js$/.test(resolved) ? resolved : `${resolved}.js`);
    }
  }
  return [...seen];
}

describe('no code that dials', () => {
  it('finds none in anything the host end process loads', () => {
    const files = reachableFrom(path.join(root, 'verdict-host/main.js'));
    expect(files.length).toBeGreaterThan(8);
    const report = Object.fromEntries(
      files.map((file) => [
        path.relative(root, file),
        dialFindings(file, fs.readFileSync(file, 'utf8')),
      ])
    );
    expect(Object.values(report).flat()).toEqual([]);
  });

  it('would flag each way of dialling it knows (the scan itself works)', () => {
    const cases = [
      "const net = require('node:net'); net.connect(80);",
      "require('node:https').get('x');",
      "require('node:dns').lookup('x');",
      "require('node:tls');",
      "http.request('http://x');",
      'fetch(url);',
      'socket.connect(80);',
      "require('node:child_process');",
      'net.createConnection(80);',
      'new net.Socket();',
    ];
    for (const source of cases) expect(dialFindings('x.js', source), source).not.toEqual([]);
    expect(
      dialFindings('x.js', "// net.connect(1)\nconst a = require('node:net'); a.createServer;")
    ).toEqual([]);
  });
});

// ---- 2. The guard refuses a dial ------------------------------------------

describe('the guard', () => {
  let canary;
  let guard;
  afterEach(async () => {
    guard?.uninstall();
    guard = undefined;
    await canary?.close();
    canary = undefined;
  });

  it('refuses every kind of outbound attempt, and the canary sees none', async () => {
    canary = await startCanary();
    guard = installNoEgress();
    const refused = [];
    const attempt = async (name, run) => {
      try {
        await run();
        refused.push(`${name}: NOT refused`);
      } catch (err) {
        const root = err.cause ?? err;
        if (!(root instanceof EgressRefusedError) && root.code !== 'EGRESS_REFUSED') {
          refused.push(`${name}: wrong error ${err.message}`);
        }
      }
    };
    await attempt('net.connect to a port', () => net.connect(canary.port, '127.0.0.1'));
    await attempt('net.connect to a path', () => net.connect({ path: '/tmp/none.sock' }));
    await attempt('http.get', () => http.get(`http://127.0.0.1:${canary.port}/`));
    await attempt('fetch', () => fetch(`http://127.0.0.1:${canary.port}/`));
    await attempt('tls.connect', () => tls.connect(canary.port, '127.0.0.1'));
    const udp = dgram.createSocket('udp4');
    await attempt('dgram send', () => udp.send('x', 9, '127.0.0.1'));
    udp.close();
    await attempt('dns.lookup', () => dns.lookup('example.invalid', () => {}));
    await attempt('dns.resolve4', () => dns.resolve4('example.invalid', () => {}));
    await attempt('dns.promises.lookup', () => dns.promises.lookup('example.invalid'));
    await attempt('Resolver', () => new dns.Resolver().resolve4('example.invalid', () => {}));
    expect(refused).toEqual([]);
    expect(canary.connections).toEqual([]);
    expect(guard.refusedCount()).toBeGreaterThanOrEqual(10);
  });

  it('still lets the process listen and accept, which is all it does', async () => {
    guard = installNoEgress();
    // Listening on an address looks the address up; an IP literal needs no query.
    const looked = await new Promise((resolve) =>
      dns.lookup('127.0.0.1', (err, a) => resolve(err ?? a))
    );
    expect(looked).toBe('127.0.0.1');
    expect(guard.refusedCount()).toBe(0);
    const server = net.createServer((socket) => socket.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    guard.uninstall();
    guard = undefined;
    const text = await new Promise((resolve) => {
      const client = net.connect(port, '127.0.0.1');
      let data = '';
      client.on('data', (chunk) => (data += chunk));
      client.on('close', () => resolve(data));
    });
    server.close();
    expect(text).toBe('ok');
  });

  it('control case: with the guard removed the same attempt reaches the canary', async () => {
    canary = await startCanary();
    guard = installNoEgress();
    guard.uninstall();
    guard = undefined;
    const socket = net.connect(canary.port, '127.0.0.1');
    await new Promise((resolve) => socket.on('close', resolve));
    expect(canary.connections).toHaveLength(1);
  });
});

// ---- 3. The whole process beside a canary ---------------------------------

describe('the host end process', () => {
  let canary;
  afterEach(async () => {
    await canary?.close();
    canary = undefined;
  });

  it('serves a full round (ask, poll, verdict) and dials nothing', async () => {
    canary = await startCanary();
    const { violations, answer } = await runOneRound({ entry: 'verdict-host/main.js', canary });
    expect(violations).toEqual([]);
    expect(answer).toMatchObject({ classification: 'no-known-match' });
  }, 20_000);

  it('control case: a variant that sends its hashes out through the guard is flagged', async () => {
    canary = await startCanary();
    const { violations } = await runOneRound({
      entry: 'test/helpers/dialing-host-variants.cjs',
      args: ['guarded'],
      canary,
    });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).toMatch(/guard refused|exited/);
    expect(canary.connections).toEqual([]);
  }, 20_000);

  it('control case: a variant with no guard that dials is flagged by the canary', async () => {
    canary = await startCanary();
    const { violations } = await runOneRound({
      entry: 'test/helpers/dialing-host-variants.cjs',
      args: ['unguarded'],
      canary,
    });
    expect(violations).toContain('the canary received a connection');
  }, 20_000);
});
