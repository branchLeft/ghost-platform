import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fakeGhost, findLeaks, json, KEY, SECRET, startFake } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));

/**
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runNode(script, args, env) {
  return new Promise((resolve, reject) => {
    // Only what the case names: no inherited GHOST_ADMIN_API_KEY.
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const cli = (/** @type {string[]} */ args, env = { GHOST_ADMIN_API_KEY: KEY }) =>
  runNode(CLI, args, env);

test('the CLI reads each thing the client reads, to stdout, exit 0', async () => {
  const fake = await startFake(fakeGhost);
  try {
    const url = ['--url', fake.url];
    const count = await cli([...url, 'member-count']);
    assert.deepEqual([count.code, count.stdout.trim(), count.stderr], [0, '42', '']);

    const found = await cli([...url, 'find-member', 'ada@example.test']);
    assert.equal(found.code, 0);
    assert.deepEqual(JSON.parse(found.stdout), { id: 'm1', email: 'ada@example.test' });

    const absent = await cli([...url, 'find-member', 'nobody@example.test']);
    assert.deepEqual([absent.code, absent.stdout.trim()], [0, 'null']);

    const letters = await cli([...url, 'newsletters']);
    assert.deepEqual(JSON.parse(letters.stdout), [{ id: 'n1', name: 'Weekly' }]);

    const title = await cli([...url, 'setting', 'title']);
    assert.equal(JSON.parse(title.stdout), 'A site');

    const support = await cli([...url, 'support-address']);
    assert.equal(JSON.parse(support.stdout), 'support@example.test');

    const csv = await cli([...url, 'export-members']);
    assert.deepEqual([csv.code, csv.stdout], [0, 'id,email\nm1,ada@example.test\n']);
  } finally {
    await fake.close();
  }
});

test('the key is read from the environment only: --key is rejected, a missing variable is exit 2', async () => {
  const fake = await startFake(fakeGhost);
  try {
    const flagged = await cli(['--url', fake.url, '--key', KEY, 'member-count']);
    assert.equal(flagged.code, 2);
    const equals = await cli(['--url', fake.url, `--key=${KEY}`, 'member-count']);
    assert.equal(equals.code, 2);
    const missing = await cli(['--url', fake.url, 'member-count'], {});
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /GHOST_ADMIN_API_KEY is not set/);
    const empty = await cli(['--url', fake.url, 'member-count'], { GHOST_ADMIN_API_KEY: '' });
    assert.equal(empty.code, 2);
    assert.equal(fake.seen.length, 0, 'a request was sent without a usable key');

    // The wrong shape is exit 2 too, and the message names the variable.
    const bad = await cli(['--url', fake.url, 'member-count'], {
      GHOST_ADMIN_API_KEY: 'distinctive-not-a-key-value',
    });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /not a Ghost Admin API key/);
    assert.ok(!(bad.stdout + bad.stderr).includes('distinctive-not-a-key-value'));
    assert.deepEqual(findLeaks(flagged.stdout + flagged.stderr + equals.stderr, { key: KEY }), []);
  } finally {
    await fake.close();
  }
});

test('usage mistakes are exit 2 and echo nothing they were given', async () => {
  const cases = [
    [],
    ['member-count'],
    ['--url', 'https://ghost.example.test'],
    ['--url', 'https://ghost.example.test', 'unknown-distinctive-command'],
    ['--url', 'https://ghost.example.test', 'find-member'],
    ['--url', 'https://ghost.example.test', 'member-count', 'extra-distinctive-arg'],
    ['--url', 'https://ghost.example.test', '--unknown-distinctive-flag', 'member-count'],
    ['--url'],
    ['--url', 'http://example.test', 'member-count'],
    ['--url', 'https://ghost.example.test', '--timeout-ms', 'soon', 'member-count'],
  ];
  for (const args of cases) {
    const result = await cli(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.ok(!/distinctive/.test(result.stderr), `echoed an argument: ${result.stderr}`);
  }
});

/** The ways a request can go wrong, each against a loopback fake. */
const FAILURES = [
  {
    name: '401',
    expected: 'GET /ghost/api/admin/members/ -> 401',
    handler: (/** @type {any} */ _req, /** @type {any} */ res) =>
      json(res, 401, { errors: [{ message: `denied ${KEY}` }] }),
  },
  {
    name: '500',
    expected: 'GET /ghost/api/admin/members/ -> 500',
    handler: (/** @type {any} */ _req, /** @type {any} */ res) =>
      json(res, 500, { errors: [{ message: SECRET }] }),
  },
  {
    name: 'redirect',
    expected: 'GET /ghost/api/admin/members/ -> redirect',
    handler: (/** @type {any} */ _req, /** @type {any} */ res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    },
  },
  {
    name: 'timeout',
    expected: 'GET /ghost/api/admin/members/ -> timeout',
    handler: () => {},
    extra: ['--timeout-ms', '300'],
  },
];

test('never logged: no failure path puts the key, its secret or a token on stdout or stderr', async () => {
  for (const failure of FAILURES) {
    const fake = await startFake(failure.handler);
    try {
      const result = await cli(['--url', fake.url, ...(failure.extra ?? []), 'member-count']);
      assert.equal(result.code, 1, failure.name);
      assert.equal(result.stdout, '', failure.name);
      assert.equal(result.stderr.trim(), failure.expected, failure.name);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.deepEqual(findLeaks(output, { key: KEY, tokens: fake.tokens() }), [], failure.name);
      assert.ok(fake.tokens().length > 0, `${failure.name}: the server saw no token to match`);
    } finally {
      await fake.close();
    }
  }
});

test('never logged: the success path leaks nothing either', async () => {
  const fake = await startFake(fakeGhost);
  try {
    for (const command of [
      ['member-count'],
      ['newsletters'],
      ['support-address'],
      ['export-members'],
    ]) {
      const result = await cli(['--url', fake.url, ...command]);
      assert.equal(result.code, 0);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.deepEqual(findLeaks(output, { key: KEY, tokens: fake.tokens() }), []);
    }
    assert.ok(fake.tokens().length >= 4);
  } finally {
    await fake.close();
  }
});

test('control: the leak matcher flags a child that prints the key, a token or part of the secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-api-leak-'));
  try {
    const leaks = {
      'the key': `console.log(process.env.GHOST_ADMIN_API_KEY);`,
      'the key id:secret on stderr': `console.error('failed for ' + process.env.GHOST_ADMIN_API_KEY);`,
      'only a token': `import { adminApiToken } from ${JSON.stringify(INDEX)};
        console.log(adminApiToken(process.env.GHOST_ADMIN_API_KEY, 1));`,
      'twelve characters of the secret': `console.log('x' + process.env.GHOST_ADMIN_API_KEY.split(':')[1].slice(20, 32) + 'y');`,
      'the key in base64': `console.log(Buffer.from(process.env.GHOST_ADMIN_API_KEY).toString('base64'));`,
    };
    for (const [name, source] of Object.entries(leaks)) {
      const script = join(dir, `${name.replace(/\W+/g, '-')}.mjs`);
      writeFileSync(script, source);
      const result = await runNode(script, [], { GHOST_ADMIN_API_KEY: KEY });
      const tokens = result.stdout.trim().split('.').length === 3 ? [result.stdout.trim()] : [];
      const found = findLeaks(`${result.stdout}\n${result.stderr}`, { key: KEY, tokens });
      assert.ok(found.length > 0, `the matcher missed a child that leaks ${name}`);
    }
    const clean = join(dir, 'clean.mjs');
    writeFileSync(clean, `console.log('GET /ghost/api/admin/members/ -> 401');`);
    const result = await runNode(clean, [], { GHOST_ADMIN_API_KEY: KEY });
    assert.deepEqual(findLeaks(`${result.stdout}\n${result.stderr}`, { key: KEY }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
