// The record and the refusal, with no Docker: gates are fakes here. The real
// gates' wiring is gates.test.mjs; the sabotage of both is prove-sabotage.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REPORT_SCHEMA,
  REQUIRED_GATES,
  digestFromDockerfile,
  main,
  reportFileName,
  runGateSet,
  verifyReport,
} from './gate-set.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const IMAGE = 'ghost-platform:ci';

const green = (name) => ({ name, run: async () => ({ ok: true, detail: '' }) });
const allGreen = () => REQUIRED_GATES.map(green);
const withGate = (name, run) =>
  allGreen().map((gate) => (gate.name === name ? { name, run } : gate));

// A clock that moves 5 ms each time it is read.
function steppedClock() {
  let t = 1_000;
  return () => (t += 5);
}

test('the six gates the node names are the required set, in cheapest-first order', () => {
  assert.deepEqual(REQUIRED_GATES, [
    'overlay-check',
    'smoke',
    'storage',
    'theme-scan',
    'mail',
    'content-policy',
  ]);
});

test('six green gates give a green record for the digest, each with its own time', async () => {
  const report = await runGateSet({
    gates: allGreen(),
    image: IMAGE,
    digest: DIGEST,
    now: steppedClock(),
  });
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.digest, DIGEST);
  assert.equal(report.image, IMAGE);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.results.map((r) => r.name),
    REQUIRED_GATES
  );
  for (const result of report.results) {
    assert.equal(result.ok, true);
    assert.equal(result.durationMs, 5);
  }
  assert.ok(report.totalMs > 0);
  assert.deepEqual(verifyReport(report, { digest: DIGEST }), { ok: true });
});

for (const name of REQUIRED_GATES) {
  test(`a red ${name} gate refuses the candidate and the other five are still recorded`, async () => {
    const gates = withGate(name, async () => ({ ok: false, detail: 'broken' }));
    const report = await runGateSet({ gates, image: IMAGE, digest: DIGEST });
    assert.equal(report.ok, false);
    assert.equal(report.results.length, REQUIRED_GATES.length);
    assert.deepEqual(
      report.results.filter((r) => !r.ok).map((r) => r.name),
      [name]
    );
    assert.equal(report.results.find((r) => r.name === name).detail, 'broken');
    const verdict = verifyReport(report, { digest: DIGEST });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'gate-red');
    assert.match(verdict.detail, new RegExp(name));
  });
}

test('a gate that throws is red, with its message recorded', async () => {
  const gates = withGate('mail', async () => {
    throw new Error('docker went away');
  });
  const report = await runGateSet({ gates, image: IMAGE, digest: DIGEST });
  const mail = report.results.find((r) => r.name === 'mail');
  assert.equal(mail.ok, false);
  assert.match(mail.detail, /docker went away/);
  assert.equal(report.ok, false);
});

test('only the boolean true passes: a truthy value or an empty return is red', async () => {
  for (const returned of [{ ok: 1 }, { ok: 'true' }, {}, undefined, null]) {
    const gates = withGate('smoke', async () => returned);
    const report = await runGateSet({ gates, image: IMAGE, digest: DIGEST });
    assert.equal(
      report.results.find((r) => r.name === 'smoke').ok,
      false,
      JSON.stringify(returned)
    );
    assert.equal(report.ok, false);
  }
});

test('a required gate that is not wired is red and says so', async () => {
  const gates = allGreen().filter((gate) => gate.name !== 'content-policy');
  const report = await runGateSet({ gates, image: IMAGE, digest: DIGEST });
  const missing = report.results.find((r) => r.name === 'content-policy');
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not wired/);
  assert.equal(report.ok, false);
});

test('an extra gate runs and a red extra refuses the candidate too', async () => {
  const gates = [...allGreen(), { name: 'extra', run: async () => ({ ok: false, detail: 'x' }) }];
  const report = await runGateSet({ gates, image: IMAGE, digest: DIGEST });
  assert.equal(report.results.at(-1).name, 'extra');
  assert.equal(report.ok, false);
  assert.equal(verifyReport(report, { digest: DIGEST }).reason, 'gate-red');
});

test('input that cannot be recorded throws: a bad digest, an empty image, a repeated name', async () => {
  await assert.rejects(
    runGateSet({ gates: allGreen(), image: IMAGE, digest: 'sha256:abc' }),
    RangeError
  );
  await assert.rejects(runGateSet({ gates: allGreen(), image: '', digest: DIGEST }), RangeError);
  await assert.rejects(
    runGateSet({ gates: [...allGreen(), green('smoke')], image: IMAGE, digest: DIGEST }),
    /two gates are named smoke/
  );
});

test('the verdict is for the digest it is asked about, whatever the record says of itself', async () => {
  const report = await runGateSet({ gates: allGreen(), image: IMAGE, digest: DIGEST });
  const verdict = verifyReport(report, { digest: OTHER });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'gate-digest-mismatch');
  assert.equal(verifyReport(report, { digest: 'latest' }).reason, 'gate-digest-mismatch');
});

test('an edited summary does not change the verdict: it is recomputed from the results', async () => {
  const gates = withGate('storage', async () => ({ ok: false }));
  const report = await runGateSet({ gates, image: IMAGE, digest: DIGEST });
  assert.equal(verifyReport({ ...report, ok: true }, { digest: DIGEST }).reason, 'gate-red');
});

test('a record without a required gate, with one repeated, or with no results is refused', async () => {
  const report = await runGateSet({ gates: allGreen(), image: IMAGE, digest: DIGEST });
  const dropped = { ...report, results: report.results.filter((r) => r.name !== 'overlay-check') };
  assert.equal(verifyReport(dropped, { digest: DIGEST }).reason, 'gate-missing');
  const repeated = { ...report, results: [...report.results, report.results[0]] };
  assert.equal(verifyReport(repeated, { digest: DIGEST }).reason, 'gate-missing');
  assert.equal(verifyReport({ ...report, results: [] }, { digest: DIGEST }).reason, 'gate-missing');
});

test('a record that is not a gate report is refused', () => {
  for (const value of [null, {}, { schema: 'other', results: [] }, { schema: REPORT_SCHEMA }]) {
    assert.equal(verifyReport(value, { digest: DIGEST }).reason, 'gate-report-malformed');
  }
});

test('the digest comes from the first FROM line, and only when it is pinned by sha256', () => {
  assert.equal(digestFromDockerfile(`FROM ghost:6.55.0-alpine@${DIGEST}\nRUN true\n`), DIGEST);
  assert.equal(
    digestFromDockerfile(`# note\nFROM --platform=linux/amd64 ghost:6@${DIGEST} AS base\n`),
    DIGEST
  );
  assert.equal(digestFromDockerfile('FROM ghost:6.55.0-alpine\n'), null);
  assert.equal(digestFromDockerfile('RUN true\n'), null);
});

test("the repository's own Dockerfile pins its base by digest", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(digestFromDockerfile(text) ?? '', /^sha256:[0-9a-f]{64}$/);
});

test('the record file is named for the digest', () => {
  assert.equal(reportFileName(DIGEST), `gate-report-${'a'.repeat(64)}.json`);
  assert.throws(() => reportFileName('latest'), RangeError);
});

// The command line.
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gate-set-'));
}
const capture = () => {
  const lines = [];
  return { lines, out: (line) => lines.push(line) };
};

test('run: green exits 0 and writes the record named for the digest', async () => {
  const dir = scratch();
  const { out, lines } = capture();
  const code = await main(['run', '--image', IMAGE, '--digest', DIGEST, '--out', dir], {
    gates: allGreen(),
    out,
    cwd: dir,
  });
  assert.equal(code, 0);
  const report = JSON.parse(fs.readFileSync(path.join(dir, reportFileName(DIGEST)), 'utf8'));
  assert.equal(report.ok, true);
  assert.match(lines.at(-1), /GATE_SET GREEN/);
  fs.rmSync(dir, { recursive: true });
});

test('run: a red gate exits 1 and the record is still written, red', async () => {
  const dir = scratch();
  const { out, lines } = capture();
  const code = await main(['run', '--image', IMAGE, '--digest', DIGEST, '--out', dir], {
    gates: withGate('theme-scan', async () => ({ ok: false, detail: 'outside origin' })),
    out,
    cwd: dir,
  });
  assert.equal(code, 1);
  const report = JSON.parse(fs.readFileSync(path.join(dir, reportFileName(DIGEST)), 'utf8'));
  assert.equal(report.ok, false);
  assert.ok(lines.some((line) => /^RED\s+theme-scan/.test(line)));
  fs.rmSync(dir, { recursive: true });
});

test('run: the digest can come from a Dockerfile; an unpinned FROM is refused with no record', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM ghost:6@${DIGEST}\n`);
  const first = capture();
  assert.equal(
    await main(['run', '--image', IMAGE, '--dockerfile', 'Dockerfile', '--out', dir], {
      gates: allGreen(),
      out: first.out,
      cwd: dir,
    }),
    0
  );
  const report = JSON.parse(fs.readFileSync(path.join(dir, reportFileName(DIGEST)), 'utf8'));
  assert.equal(report.source, 'dockerfile');

  const unpinned = scratch();
  fs.writeFileSync(path.join(unpinned, 'Dockerfile'), 'FROM ghost:6\n');
  const second = capture();
  assert.equal(
    await main(['run', '--image', IMAGE, '--dockerfile', 'Dockerfile'], {
      gates: allGreen(),
      out: second.out,
      cwd: unpinned,
    }),
    1
  );
  assert.deepEqual(fs.readdirSync(unpinned), ['Dockerfile']);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(unpinned, { recursive: true });
});

test('run: a command line that cannot be used exits 2 and runs nothing', async () => {
  let ran = false;
  const gates = [{ name: 'smoke', run: async () => ((ran = true), { ok: true }) }];
  for (const argv of [
    [],
    ['run'],
    ['run', '--image', IMAGE],
    ['run', '--image', IMAGE, '--digest', DIGEST, '--dockerfile', 'Dockerfile'],
    ['run', '--image', IMAGE, '--digest', 'sha256:short'],
    ['bogus'],
  ]) {
    const { out } = capture();
    assert.equal(await main(argv, { gates, out }), 2, JSON.stringify(argv));
  }
  assert.equal(ran, false);
});

test('verify: green record 0; red, wrong digest or unreadable record 1; missing flags 2', async () => {
  const dir = scratch();
  const goodReport = await runGateSet({ gates: allGreen(), image: IMAGE, digest: DIGEST });
  const badReport = await runGateSet({
    gates: withGate('mail', async () => ({ ok: false })),
    image: IMAGE,
    digest: DIGEST,
  });
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(goodReport));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(badReport));
  fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
  const run = (argv) => main(argv, { gates: [], out: () => {}, cwd: dir });
  assert.equal(await run(['verify', '--report', 'good.json', '--digest', DIGEST]), 0);
  assert.equal(await run(['verify', '--report', 'bad.json', '--digest', DIGEST]), 1);
  assert.equal(await run(['verify', '--report', 'good.json', '--digest', OTHER]), 1);
  assert.equal(await run(['verify', '--report', 'junk.json', '--digest', DIGEST]), 1);
  assert.equal(await run(['verify', '--report', 'absent.json', '--digest', DIGEST]), 1);
  assert.equal(await run(['verify', '--report', 'good.json']), 2);
  fs.rmSync(dir, { recursive: true });
});
