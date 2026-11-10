// The real gates' wiring, with no Docker: a recorder stands in for the command
// runner. Each gate must run the check it stands for, against the image it was
// given, and be red when that check exits non-zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_GATES } from './gate-set.mjs';
import { OVERLAYS, expectedOverlayHashes, judgeOverlays, realGates } from './gates.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const IMAGE = 'ghost-platform:ci';
const DIGEST = `sha256:${'c'.repeat(64)}`;

// A recorder: calls are kept, and `fail` names the argv fragments that exit 1.
function recorder({ fail = [], overlayOutput } = {}) {
  const calls = [];
  const exec = async (argv, options = {}) => {
    calls.push({ argv, ...options });
    const line = argv.join(' ');
    if (argv[0] === 'docker') {
      return fail.some((f) => line.includes(f))
        ? { code: 1, output: 'docker failed' }
        : { code: 0, output: overlayOutput ?? goodOverlayOutput() };
    }
    return fail.some((f) => line.includes(f))
      ? { code: 1, output: `${line.split(' ').at(-1)} failed` }
      : { code: 0, output: '' };
  };
  return { calls, exec };
}

function goodOverlayOutput() {
  return expectedOverlayHashes(ROOT)
    .map((overlay) => `${overlay.expected}  ${overlay.imagePath}`)
    .join('\n');
}

const gateNamed = (gates, name) => gates.find((gate) => gate.name === name);

test('the real gates are exactly the required set, none missing and none extra', () => {
  const gates = realGates({ repoRoot: ROOT, exec: recorder().exec });
  assert.deepEqual(
    gates.map((gate) => gate.name),
    REQUIRED_GATES
  );
});

// The check each gate stands for: a fragment its command line must carry.
const COMMANDS = {
  smoke: 'scripts/smoke-test.sh',
  storage: 'scripts/test-storage-guard.sh',
  'theme-scan': 'themes/image/themes.image.test.mjs',
  mail: 'scripts/mail-gate/mail-gate.mjs',
  'content-policy': 'csp/gate/csp-regression-gate.sh',
};

for (const [name, fragment] of Object.entries(COMMANDS)) {
  test(`${name}: runs ${fragment} on the candidate image and is green when it exits 0`, async () => {
    const { calls, exec } = recorder();
    const outcome = await gateNamed(realGates({ repoRoot: ROOT, exec }), name).run({
      image: IMAGE,
      digest: DIGEST,
    });
    assert.equal(outcome.ok, true);
    const call = calls.find((c) => c.argv.join(' ').includes(fragment));
    assert.ok(call, `a command carries ${fragment}`);
    const carriesImage = call.argv.includes(IMAGE) || call.env?.IMAGE === IMAGE;
    assert.ok(carriesImage, 'the candidate image is handed to the check');
  });

  test(`${name}: is red when ${fragment} exits non-zero, with its output kept`, async () => {
    const { exec } = recorder({ fail: [fragment] });
    const outcome = await gateNamed(realGates({ repoRoot: ROOT, exec }), name).run({
      image: IMAGE,
      digest: DIGEST,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /failed/);
  });
}

test('storage: the image tests run in the scanning-storage directory with IMAGE set', async () => {
  const { calls, exec } = recorder();
  await gateNamed(realGates({ repoRoot: ROOT, exec }), 'storage').run({
    image: IMAGE,
    digest: DIGEST,
  });
  const imageTests = calls.find((c) => c.argv.join(' ').includes('test/image/*.image.test.mjs'));
  assert.equal(imageTests.cwd, path.join(ROOT, 'adapters', 'scanning-storage'));
  assert.equal(imageTests.env.IMAGE, IMAGE);
});

test('storage: both checks are needed, and either one failing is red', async () => {
  for (const fragment of ['scripts/test-storage-guard.sh', 'test/image/*.image.test.mjs']) {
    const { exec } = recorder({ fail: [fragment] });
    const outcome = await gateNamed(realGates({ repoRoot: ROOT, exec }), 'storage').run({
      image: IMAGE,
      digest: DIGEST,
    });
    assert.equal(outcome.ok, false, fragment);
  }
});

test('the image files the checks read exist in the repository', () => {
  for (const fragment of Object.values(COMMANDS)) {
    assert.ok(fs.existsSync(path.join(ROOT, fragment)), fragment);
  }
  const dir = path.join(ROOT, 'adapters', 'scanning-storage', 'test', 'image');
  assert.ok(fs.readdirSync(dir).some((file) => file.endsWith('.image.test.mjs')));
});

// The overlay check.
test('overlay-check: green when every overlaid file in the image is the pinned bytes', async () => {
  const { calls, exec } = recorder();
  const outcome = await gateNamed(realGates({ repoRoot: ROOT, exec }), 'overlay-check').run({
    image: IMAGE,
    digest: DIGEST,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls[0].argv.slice(0, 6), [
    'docker',
    'run',
    '--rm',
    '--entrypoint',
    'sha256sum',
    IMAGE,
  ]);
  assert.deepEqual(
    calls[0].argv.slice(6),
    OVERLAYS.map((overlay) => overlay.imagePath)
  );
});

test('overlay-check: one overlaid file with other bytes is red and named', async () => {
  const good = goodOverlayOutput().split('\n');
  const drifted = [
    `${'0'.repeat(64)}  ${OVERLAYS[1].imagePath}`,
    ...good.filter((l) => !l.includes(OVERLAYS[1].imagePath)),
  ];
  const { exec } = recorder({ overlayOutput: drifted.join('\n') });
  const outcome = await gateNamed(realGates({ repoRoot: ROOT, exec }), 'overlay-check').run({
    image: IMAGE,
    digest: DIGEST,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /stripe-connect-limit: bytes differ/);
});

test('overlay-check: an overlaid file missing from the image is red', async () => {
  const lines = goodOverlayOutput().split('\n').slice(1);
  const { exec } = recorder({ overlayOutput: lines.join('\n') });
  const outcome = await gateNamed(realGates({ repoRoot: ROOT, exec }), 'overlay-check').run({
    image: IMAGE,
    digest: DIGEST,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /not in the image/);
});

test('overlay-check: sha256sum failing in the image is red, never an empty comparison', async () => {
  const { exec } = recorder({ fail: ['sha256sum'] });
  const outcome = await gateNamed(realGates({ repoRoot: ROOT, exec }), 'overlay-check').run({
    image: IMAGE,
    digest: DIGEST,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /sha256sum in the image failed/);
});

test('overlay-check: a pin file that holds no sha256 throws, so the gate is red', async () => {
  const damaged = (file, encoding) =>
    file.endsWith('.sha256') ? 'not a hash\n' : fs.readFileSync(file, encoding);
  const gate = gateNamed(
    realGates({ repoRoot: ROOT, exec: recorder().exec, readFile: damaged }),
    'overlay-check'
  );
  await assert.rejects(gate.run({ image: IMAGE, digest: DIGEST }), /does not hold a sha256/);
});

test('the expected hashes come from the committed pins and the committed overlay file', () => {
  const expected = expectedOverlayHashes(ROOT);
  assert.equal(expected.length, OVERLAYS.length);
  for (const overlay of expected) assert.match(overlay.expected, /^[0-9a-f]{64}$/);
  const overlayFile = fs.readFileSync(
    path.join(ROOT, 'adapters/scanning-storage/ghost-core-overlay/theme-storage.js')
  );
  assert.equal(
    expected.find((o) => o.name === 'theme-storage-overlay').expected,
    crypto.createHash('sha256').update(overlayFile).digest('hex')
  );
});

test('judgeOverlays: matching bytes give no problems; other bytes and absent files each give one', () => {
  const expected = [
    { name: 'a', imagePath: '/x/a.js', expected: '1'.repeat(64) },
    { name: 'b', imagePath: '/x/b.js', expected: '2'.repeat(64) },
  ];
  assert.deepEqual(
    judgeOverlays(expected, `${'1'.repeat(64)}  /x/a.js\n${'2'.repeat(64)}  /x/b.js\n`),
    []
  );
  assert.deepEqual(
    judgeOverlays(expected, `${'1'.repeat(64)}  /x/a.js\n${'3'.repeat(64)}  /x/b.js\n`),
    ['b: bytes differ from the pin']
  );
  assert.deepEqual(judgeOverlays(expected, `${'1'.repeat(64)}  /x/a.js\n`), [
    'b: not in the image',
  ]);
  assert.deepEqual(judgeOverlays(expected, ''), ['a: not in the image', 'b: not in the image']);
});
