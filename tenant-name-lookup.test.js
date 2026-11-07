// Provisioning refuses a tenant name the control plane says is taken. The
// control plane is a fake HTTP server on loopback; no real tenant name appears
// anywhere: the taken name is a lower-cased ALL_CAPS placeholder.
//
// Control cases: taken is refused (exit 1) for a name that is NOT in the repo
// register, free is accepted (exit 0), every other answer is a refusal (exit 2).
// Sabotage: a copy of the module with the taken branch removed lets the taken
// name through, which is what the "taken is refused" assertion would catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT = path.join(
  import.meta.dirname,
  'infra',
  'provisioning',
  'scripts',
  'tenant-name-lookup.js'
);
const { run, isNameTaken, LookupRefused } = await import(pathToFileURL(SCRIPT).href);

const NAME = 'CUSTOMER_NAME_PLACEHOLDER'.toLowerCase().replaceAll('_', '-');
const TOKEN = 'FAKE_LOOKUP_TOKEN_FOR_TESTS';
const BODY_SENTINEL = 'RESPONSE_BODY_SENTINEL';

async function startFake(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const answer = (status, body) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

// Async spawn: a synchronous one would block the event loop the fake runs on.
function runCli(env, script = SCRIPT, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const envFor = (fake, extra = {}) => ({
  TENANT: NAME,
  CONTROL_PLANE_NAME_LOOKUP_URL: fake.url,
  CONTROL_PLANE_NAME_LOOKUP_TOKEN: TOKEN,
  ...extra,
});

async function withFake(handler, fn) {
  const fake = await startFake(handler);
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

test('a name the control plane says is taken is refused, though it is not in the repo register', async () => {
  const register = fs.readFileSync(
    path.join(import.meta.dirname, 'registers', 'tenant-names.json'),
    'utf-8'
  );
  assert.ok(
    !register.includes(NAME),
    'the control case: the repo register does not hold this name'
  );
  await withFake(answer(200, { taken: true }), async (fake) => {
    const result = await runCli(envFor(fake));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already taken/);
    assert.equal(result.stdout, '');
  });
});

test('a name the control plane says is free is accepted', async () => {
  await withFake(answer(200, { taken: false }), async (fake) => {
    const result = await runCli(envFor(fake));
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  });
});

test('exactly one GET to one path with the bearer token, and the token is never printed', async () => {
  for (const taken of [true, false]) {
    await withFake(answer(200, { taken }), async (fake) => {
      const result = await runCli(envFor(fake));
      assert.equal(fake.requests.length, 1);
      assert.deepEqual(fake.requests[0], {
        method: 'GET',
        url: `/tenant-names/${NAME}`,
        authorization: `Bearer ${TOKEN}`,
      });
      assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
    });
  }
});

test('a base URL with a path keeps the path and still asks for one name', async () => {
  await withFake(answer(200, { taken: false }), async (fake) => {
    const result = await runCli(
      envFor(fake, { CONTROL_PLANE_NAME_LOOKUP_URL: `${fake.url}/api/v1/` })
    );
    assert.equal(result.code, 0);
    assert.equal(fake.requests[0].url, `/api/v1/tenant-names/${NAME}`);
  });
});

const REFUSED_ANSWERS = [
  ['401', answer(401, { taken: false })],
  ['403', answer(403, { taken: false })],
  ['404', answer(404, { taken: false })],
  ['500', answer(500, { taken: false })],
  ['204 with no body', (_req, res) => res.writeHead(204).end()],
  ['malformed JSON', answer(200, '{"taken":')],
  ['not JSON', answer(200, 'free')],
  ['a string for taken', answer(200, { taken: 'no' })],
  ['a number for taken', answer(200, { taken: 0 })],
  ['null for taken', answer(200, { taken: null })],
  ['no taken field', answer(200, { free: true })],
  ['a JSON array', answer(200, [true])],
  ['an oversize body', answer(200, JSON.stringify({ taken: false, pad: 'x'.repeat(5000) }))],
  [
    'a redirect',
    (_req, res) => res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end(),
  ],
];

for (const [label, handler] of REFUSED_ANSWERS) {
  test(`fails closed (exit 2) on ${label}`, async () => {
    await withFake(handler, async (fake) => {
      const result = await runCli(envFor(fake));
      assert.equal(result.code, 2);
      assert.match(result.stderr, /refused \(fail closed\)/);
      assert.ok(!result.stdout.includes('free'));
    });
  });
}

test('fails closed when the control plane hangs past the timeout', async () => {
  await withFake(
    () => {},
    async (fake) => {
      const out = [];
      const err = [];
      const code = await run({
        env: envFor(fake),
        timeoutMs: 200,
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
      });
      assert.equal(code, 2);
      assert.equal(out.length, 0);
      assert.match(err.join(''), /could not be reached, or did not answer in time/);
    }
  );
});

test('fails closed when nothing is listening', async () => {
  const fake = await startFake(answer(200, { taken: false }));
  const url = fake.url;
  await fake.close();
  const result = await runCli({
    TENANT: NAME,
    CONTROL_PLANE_NAME_LOOKUP_URL: url,
    CONTROL_PLANE_NAME_LOOKUP_TOKEN: TOKEN,
  });
  assert.equal(result.code, 2);
});

for (const missing of [
  'TENANT',
  'CONTROL_PLANE_NAME_LOOKUP_URL',
  'CONTROL_PLANE_NAME_LOOKUP_TOKEN',
]) {
  test(`fails closed with ${missing} unset, and sends nothing`, async () => {
    await withFake(answer(200, { taken: false }), async (fake) => {
      const env = envFor(fake);
      delete env[missing];
      const result = await runCli(env);
      assert.equal(result.code, 2);
      assert.equal(fake.requests.length, 0);
    });
  });
}

const BAD_INPUTS = [
  ['a path-traversal name', { TENANT: '../x' }],
  ['a name with a slash', { TENANT: 'a/b' }],
  ['a name with a query', { TENANT: 'a?b=1' }],
  ['an upper-case name', { TENANT: 'Blog' }],
  ['an empty name', { TENANT: '' }],
];
for (const [label, extra] of BAD_INPUTS) {
  test(`refuses ${label} locally, before any request`, async () => {
    await withFake(answer(200, { taken: false }), async (fake) => {
      const result = await runCli(envFor(fake, extra));
      assert.equal(result.code, 2);
      assert.equal(fake.requests.length, 0);
    });
  });
}

const BAD_URLS = [
  ['plain http to a non-loopback host', 'http://control-plane.invalid'],
  ['a non-URL', 'not a url'],
  ['credentials in the URL', 'https://user:pass@control-plane.invalid'],
  ['a query string', 'https://control-plane.invalid/?x=1'],
  ['a fragment', 'https://control-plane.invalid/#x'],
  ['another scheme', 'ftp://control-plane.invalid'],
];
for (const [label, url] of BAD_URLS) {
  test(`refuses ${label} as the base URL`, async () => {
    const result = await runCli({
      TENANT: NAME,
      CONTROL_PLANE_NAME_LOOKUP_URL: url,
      CONTROL_PLANE_NAME_LOOKUP_TOKEN: TOKEN,
    });
    assert.equal(result.code, 2);
    assert.ok(!result.stderr.includes(TOKEN));
  });
}

test('an https base URL is accepted for the request (no network: the fetch is injected)', async () => {
  const seen = [];
  const taken = await isNameTaken({
    name: NAME,
    baseUrl: 'https://control-plane.invalid',
    token: TOKEN,
    fetchImpl: async (url, init) => {
      seen.push({ url, method: init.method, redirect: init.redirect });
      return new Response(JSON.stringify({ taken: true }), { status: 200 });
    },
  });
  assert.equal(taken, true);
  assert.deepEqual(seen, [
    { url: `https://control-plane.invalid/tenant-names/${NAME}`, method: 'GET', redirect: 'error' },
  ]);
});

test('the CLI takes no arguments', async () => {
  await withFake(answer(200, { taken: false }), async (fake) => {
    const result = await runCli(envFor(fake), SCRIPT, ['--name', NAME]);
    assert.equal(result.code, 2);
    assert.equal(fake.requests.length, 0);
  });
});

test('neither the response body nor the token reaches stdout or stderr', async () => {
  const handlers = [
    answer(500, { detail: BODY_SENTINEL }),
    answer(200, { taken: true, detail: BODY_SENTINEL }),
    answer(200, { taken: false, detail: BODY_SENTINEL }),
    answer(200, `not json ${BODY_SENTINEL}`),
  ];
  for (const handler of handlers) {
    await withFake(handler, async (fake) => {
      const { stdout, stderr } = await runCli(envFor(fake));
      for (const text of [stdout, stderr]) {
        assert.ok(!text.includes(BODY_SENTINEL), 'the response body is never printed');
        assert.ok(!text.includes(TOKEN), 'the token is never printed');
      }
    });
  }
});

test('LookupRefused is what a bad answer throws from the function itself', async () => {
  await withFake(answer(200, { taken: 'maybe' }), async (fake) => {
    await assert.rejects(
      isNameTaken({ name: NAME, baseUrl: fake.url, token: TOKEN }),
      (error) => error instanceof LookupRefused
    );
  });
});

test('lookups write nothing: the register and both package name copies are byte-identical after', async () => {
  const files = [
    path.join('registers', 'tenant-names.json'),
    path.join('render-core', 'src', 'naming.ts'),
    path.join('infra', 'tenant', 'naming.ts'),
  ].map((relative) => path.join(import.meta.dirname, relative));
  const digest = () =>
    files.map((file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  const before = digest();
  for (const taken of [true, false]) {
    await withFake(answer(200, { taken }), async (fake) => {
      await runCli(envFor(fake));
    });
  }
  assert.deepEqual(digest(), before);
  for (const file of files) assert.ok(!fs.readFileSync(file, 'utf-8').includes(NAME));
});

test('sabotage: with the taken branch removed, the taken name is let through (the test above would go red)', async () => {
  const source = fs.readFileSync(SCRIPT, 'utf-8');
  const broken = source.replace('if (taken) {', 'if (false) {');
  assert.notEqual(broken, source, 'the mutation applied');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-name-lookup-sabotage-'));
  try {
    const copy = path.join(directory, 'tenant-name-lookup.mjs');
    fs.writeFileSync(copy, broken);
    await withFake(answer(200, { taken: true }), async (fake) => {
      const sabotaged = await runCli(envFor(fake), copy);
      assert.equal(
        sabotaged.code,
        0,
        'sabotaged: a taken name is accepted, so "taken is refused" would fail'
      );
      const real = await runCli(envFor(fake));
      assert.equal(real.code, 1, 'restored: the same taken answer is refused');
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
