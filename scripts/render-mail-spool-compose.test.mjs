// Runs scripts/render-mail-spool-compose.mjs against the built render-core
// (`pnpm run build` in render-core first). The non-Sweego renders must be the
// committed demo1 golden byte for byte; a Sweego host must carry exactly one
// extra line, SHIM_DRAIN_OUTCOMES: 'true', straight after SHIM_DRAIN_HOST.
// Run: node --test scripts/render-mail-spool-compose.test.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'render-mail-spool-compose.mjs');
const golden = readFileSync(
  join(here, '..', 'render-core', 'test', 'golden', 'mail-spool-compose.demo1.yml'),
  'utf-8'
);
const image = /^ {4}image: '([^']+)'$/m.exec(golden)[1];
const UIDS = ['30001', '30002', '30003', '30004', '30005', '30006', '30007'];
const DRAIN_HOST_LINE = "      SHIM_DRAIN_HOST: '10.231.200.2'";
const OUTCOMES_LINE = "      SHIM_DRAIN_OUTCOMES: 'true'";

const work = mkdtempSync(join(tmpdir(), 'render-spool-compose-'));
after(() => rmSync(work, { recursive: true, force: true }));

function mailsFile(name, specs) {
  const path = join(work, name);
  writeFileSync(path, JSON.stringify(specs));
  return path;
}

function render(extra) {
  return execFileSync(process.execPath, [script, ...extra, image, '8095', ...UIDS], {
    encoding: 'utf-8',
  });
}

function run(extra) {
  return spawnSync(process.execPath, [script, ...extra, image, '8095', ...UIDS], {
    encoding: 'utf-8',
  });
}

const SWEEGO = mailsFile('sweego.json', [
  {},
  { route: { primary: 'sweego', sweegoAllowance: 100 } },
]);
const MX1 = mailsFile('mx1.json', [{}, { route: { primary: 'mx1' } }]);

describe('a host with a Sweego route', () => {
  it('renders SHIM_DRAIN_OUTCOMES: the exact string, once, after SHIM_DRAIN_HOST', () => {
    const rendered = render(['--mails', SWEEGO]);
    assert.equal(rendered.split('\n').filter((line) => line === OUTCOMES_LINE).length, 1);
    assert.match(rendered, /SHIM_DRAIN_OUTCOMES: 'true'/);
    assert.doesNotMatch(rendered, /SHIM_DRAIN_OUTCOMES: true\b/);
  });

  it('differs from the golden by exactly that one line', () => {
    const expected = golden
      .split('\n')
      .flatMap((line) => (line === DRAIN_HOST_LINE ? [line, OUTCOMES_LINE] : [line]))
      .join('\n');
    assert.equal(render(['--mails', SWEEGO]), expected);
  });
});

describe('a host with no Sweego route', () => {
  it('renders the committed golden byte for byte with mx1 mail specs', () => {
    assert.equal(render(['--mails', MX1]), golden);
  });

  it('renders the committed golden byte for byte with no --mails at all', () => {
    assert.equal(render([]), golden);
  });
});

describe('--mails is refused when it cannot be trusted', () => {
  it('refuses a route whose primary is not a known route', () => {
    const bad = mailsFile('bad-route.json', [{ route: { primary: 'Sweego' } }]);
    const result = run(['--mails', bad]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /route\.primary must be one of mx1, sweego/);
    assert.equal(result.stdout, '');
  });

  it('refuses a file that is not an array of objects', () => {
    const bad = mailsFile('not-array.json', { route: { primary: 'sweego' } });
    const result = run(['--mails', bad]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSON array/);
  });
});
