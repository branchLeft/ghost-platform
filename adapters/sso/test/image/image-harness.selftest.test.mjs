// Self-test of test-support/image-harness.mjs. It needs no IMAGE and no
// Docker (the docker it meets is a stub on PATH), and it lives here because
// the required `docker build` job runs every file in this directory on every
// pull request, whereas the SSO adapter's own workflow is path-filtered.
// Each failure mode is shown red (the old behaviour) and then green (the
// harness), in real child processes.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimPort,
  docker,
  dockerSync,
  pollHttp200,
  releasePort,
  runStep,
} from '../../../../test-support/image-harness.mjs';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../test-support/fixtures'
);
const SIGNATURE = 'Promise resolution is still pending but the event loop has already resolved';

// Under `node --test` the environment names a test context; a nested child
// that inherits it would report to this runner instead of printing.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runFixture(mode) {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', path.join(FIXTURES, 'lost-promise.fixture.mjs')],
    { encoding: 'utf8', env: childEnv({ FIXTURE_MODE: mode }), timeout: 60_000 }
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('a setup step that never settles', () => {
  it('RED control: bare, every test is cancelled with the silent signature', () => {
    const { status, output } = runFixture('bare');
    assert.notEqual(status, 0);
    assert.ok(output.includes(SIGNATURE), output);
    assert.ok(output.includes('cancelledByParent'), output);
  });

  it('GREEN: inside runStep, the hook fails with the step named and no silent cancellation', () => {
    const { status, output } = runFixture('guarded');
    assert.notEqual(status, 0);
    assert.ok(output.includes('setup step "boot ghost" did not settle in 300ms'), output);
    assert.ok(!output.includes(SIGNATURE), output);
  });
});

describe('runStep', () => {
  it('resolves with the value of a step that settles', async () => {
    assert.equal(await runStep('quick', async () => 42, { deadlineMs: 1000 }), 42);
  });

  it('prefixes a rejection with the step name and keeps the cause', async () => {
    const original = new Error('boom');
    await assert.rejects(
      runStep('selftest step', async () => Promise.reject(original), { deadlineMs: 1000 }),
      (err) => err.message === 'setup step "selftest step" failed: boom' && err.cause === original
    );
  });
});

describe('a docker command that fails', () => {
  let stubDir;
  let savedPath;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stub-'));
    // `inspect` reports Running=true; everything else exits 125 with a reason.
    fs.writeFileSync(
      path.join(stubDir, 'docker'),
      [
        '#!/bin/sh',
        'if [ "$1" = "inspect" ]; then echo true; exit 0; fi',
        'echo "driver failed: port is already allocated" >&2',
        'exit 125',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}${path.delimiter}${savedPath}`;
  });

  after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('names the step, the argv, the exit code and the stderr, and never shows -e values', () => {
    assert.throws(
      () =>
        docker(
          'create',
          '--name',
          'x',
          '-e',
          'DB_PASSWORD=hunter2',
          '-p',
          '127.0.0.1:1:2368',
          'img'
        ),
      (err) =>
        err.message.includes('docker create failed (exit 125)') &&
        err.message.includes('argv: docker create --name x -p 127.0.0.1:1:2368 img') &&
        err.message.includes('(and 1 -e variables, values not shown)') &&
        err.message.includes('stderr: driver failed: port is already allocated') &&
        !err.message.includes('hunter2')
    );
  });

  it('keeps an explicit step name', () => {
    assert.throws(
      () => dockerSync('start tenant ghost', 'start', 'x'),
      /^DockerStepError: start tenant ghost failed/
    );
  });

  it('pollHttp200 reports the last error and the container state when it gives up', async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 503;
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await pollHttp200(`http://127.0.0.1:${server.address().port}/`, {
        containerName: 'x',
        deadlineMs: 600,
        sleepMs: 50,
      });
      assert.equal(result.ok, false);
      assert.match(result.detail, /last error: HTTP 503; Running=true/);
    } finally {
      server.close();
    }
  });
});

describe('pollHttp200', () => {
  it('returns ok as soon as the url answers 200', async () => {
    const server = http.createServer((req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await pollHttp200(`http://127.0.0.1:${server.address().port}/`);
      assert.equal(result.ok, true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('logs a hung attempt by name, abandons it and carries on to the next', async () => {
    let seen = 0;
    const server = http.createServer((req, res) => {
      seen += 1;
      if (seen > 1) res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const lines = [];
    try {
      const result = await pollHttp200(`http://127.0.0.1:${server.address().port}/`, {
        attemptMs: 150,
        sleepMs: 20,
        deadlineMs: 5000,
        log: (line) => lines.push(line),
      });
      assert.equal(result.ok, true);
      assert.ok(
        lines.some((l) => /attempt 1 attempt did not settle in 150ms; continuing/.test(l)),
        lines.join('\n')
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('stops early with the container state when the container is not running', async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stub-'));
    fs.writeFileSync(path.join(stubDir, 'docker'), '#!/bin/sh\necho false\n', { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${stubDir}${path.delimiter}${saved}`;
    try {
      const closed = http.createServer();
      await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const { port } = closed.address();
      await new Promise((resolve) => closed.close(resolve));
      const result = await pollHttp200(`http://127.0.0.1:${port}/`, {
        containerName: 'gone',
        deadlineMs: 5000,
        sleepMs: 20,
      });
      assert.equal(result.ok, false);
      assert.match(
        result.detail,
        /container stopped after 1 attempt\(s\); last error: ECONNREFUSED; Running=false/
      );
    } finally {
      process.env.PATH = saved;
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

describe('the port registry', () => {
  let registry;

  before(() => {
    registry = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ports-'));
    process.env.IMAGE_HARNESS_PORT_DIR = registry;
  });

  after(() => {
    delete process.env.IMAGE_HARNESS_PORT_DIR;
    fs.rmSync(registry, { recursive: true, force: true });
  });

  it('refuses a port a live process holds, and reaps a claim whose process is dead', () => {
    assert.equal(claimPort(29_990), true);
    assert.equal(claimPort(29_990), false, 'a live holder (this process) must keep its claim');
    // pid 2^22+1 exceeds every default pid_max, so no such process exists.
    fs.writeFileSync(path.join(registry, '29990', 'pid'), String(2 ** 22 + 1));
    assert.equal(claimPort(29_990), true, 'a dead holder is reaped');
    assert.equal(fs.readFileSync(path.join(registry, '29990', 'pid'), 'utf8'), String(process.pid));
    releasePort(29_990);
    assert.equal(fs.existsSync(path.join(registry, '29990')), false);
  });

  // A child prints its ports as one JSON line and then waits for stdin to
  // close; collecting every line before closing any stdin means all children
  // hold their claims while the others are still reserving.
  async function reserveConcurrently(argvFor, children, perChild, env) {
    const procs = Array.from({ length: children }, () =>
      spawn(process.execPath, argvFor(perChild), {
        env: childEnv(env),
        stdio: ['pipe', 'pipe', 'inherit'],
      })
    );
    const lists = await Promise.all(
      procs.map(
        (proc) =>
          new Promise((resolve, reject) => {
            let text = '';
            proc.stdout.on('data', (chunk) => {
              text += chunk;
              if (text.includes('\n')) resolve(JSON.parse(text));
            });
            proc.once('error', reject);
            proc.once('exit', (code) => reject(new Error(`child exited ${code} before reporting`)));
          })
      )
    );
    await Promise.all(
      procs.map(
        (proc) =>
          new Promise((resolve) => {
            proc.removeAllListeners('exit');
            proc.once('exit', resolve);
            proc.stdin.end();
          })
      )
    );
    return lists.flat();
  }

  const duplicates = (ports) => ports.length - new Set(ports).size;
  const CHILDREN = 8;
  const PER_CHILD = 150;

  // The old probe, defined here only as the control: bind port 0, read the
  // port, close it, and publish the number to Docker later.
  const LEGACY = `
    import net from 'node:net';
    const freePort = () => new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
    const ports = [];
    for (let i = 0; i < Number(process.argv[1]); i += 1) ports.push(await freePort());
    process.stdout.write(JSON.stringify(ports) + '\\n');
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once('end', resolve));
  `;

  // Linux draws bind(0) ports at random, which is what makes the race; macOS
  // hands them out in sequence, so the control can only show it on Linux.
  const onLinux = process.platform === 'linux';
  const skipControl = onLinux ? false : 'the kernel hands out bind(0) ports in sequence here';

  it(
    'RED control: the bind-and-close probe hands the same port to concurrent processes',
    { skip: skipControl },
    async (t) => {
      const ports = await reserveConcurrently(
        (n) => ['--input-type=module', '-e', LEGACY, String(n)],
        CHILDREN,
        PER_CHILD,
        {}
      );
      t.diagnostic(
        `legacy probe: ${ports.length} ports handed out, ${duplicates(ports)} duplicates`
      );
      assert.equal(ports.length, CHILDREN * PER_CHILD);
      assert.ok(
        duplicates(ports) > 0,
        'the control must show the race, or the green case proves nothing'
      );
    }
  );

  it('GREEN: reservePort hands out only distinct ports to concurrent processes', async (t) => {
    const ports = await reserveConcurrently(
      (n) => [path.join(FIXTURES, 'reserve-ports.fixture.mjs'), String(n)],
      CHILDREN,
      PER_CHILD,
      { IMAGE_HARNESS_PORT_DIR: registry }
    );
    t.diagnostic(`reservePort: ${ports.length} ports handed out, ${duplicates(ports)} duplicates`);
    assert.equal(ports.length, CHILDREN * PER_CHILD);
    assert.equal(duplicates(ports), 0);
    assert.ok(ports.every((p) => p >= 20_000 && p <= 29_999));
    assert.deepEqual(
      fs.readdirSync(registry),
      [],
      'every claim is released when its process exits'
    );
  });
});
