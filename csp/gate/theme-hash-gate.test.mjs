// Tests for the theme-hash gate, against render-core's real built
// renderEdgeSiteBlock (run `npm ci && npm run build` in render-core first).
// Only node:test -- no package.json here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitTheme, verifyAdmission, REPORT_ONLY_FLAG } from './theme-hash-gate.mjs';
import { renderEdgeSiteBlock, CURRENT_SCHEMA_VERSION } from '../../render-core/dist/index.js';

const DESCRIPTOR = {
  version: CURRENT_SCHEMA_VERSION,
  kind: 'tenant',
  siteUrl: 'https://t.platform-domain.example.test',
  hostname: { kind: 'ours', sub: 't', gated: false },
  gate: { kind: 'none' },
};
const ZONES = {
  platformZone: 'platform-domain.example.test',
  ownedDomains: ['platform-domain.example.test'],
};
const LIMITS = {
  tmpfsSize: '128m',
  themeCompressedBytes: 1,
  themeEntryUncompressedBytes: 1,
  themeTotalUncompressedBytes: 1,
  edgeRequestBodyMaxSize: '64MiB',
  memoryLimit: '640m',
};
const render = (themeCsp) => renderEdgeSiteBlock(DESCRIPTOR, ZONES, LIMITS, themeCsp);

const page = (s) => `<html><head><script>${s}</script></head></html>`;
const okFetch = async () => ({ ok: true, status: 200, text: async () => page('console.log(1)') });
const badFetch = async () => ({ ok: false, status: 500, text: async () => '' });
const throwFetch = async () => {
  throw new Error('connection refused');
};
const bareFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => '<html>no scripts</html>',
});

test('a theme whose hashes compute is recorded and rendered enforcing', async () => {
  const admission = await admitTheme('http://ghost', ['/', '/p/'], okFetch);
  assert.equal(admission.record.mode, 'enforcing');
  assert.equal(admission.record.hashes.length, 1);
  assert.equal(admission.record.flag, null);
  assert.deepEqual(verifyAdmission(admission, render(admission.themeCsp)), []);
});

test('CONTROL: a page that fails to fetch is recorded report-only with the flag, and the gate holds', async () => {
  for (const f of [badFetch, throwFetch]) {
    const admission = await admitTheme('http://ghost', ['/'], f);
    assert.equal(admission.record.mode, 'report-only');
    assert.equal(admission.record.flag, REPORT_ONLY_FLAG);
    assert.deepEqual(verifyAdmission(admission, render(admission.themeCsp)), []);
  }
});

test('CONTROL: an empty hash set is treated as uncomputable, never enforced', async () => {
  const admission = await admitTheme('http://ghost', ['/'], bareFetch);
  assert.equal(admission.record.mode, 'report-only');
  assert.equal(render(admission.themeCsp).contentSecurityPolicyMode, 'report-only');
});

test('the gate goes red when an uncomputable theme is rendered enforcing', async () => {
  const admission = await admitTheme('http://ghost', ['/'], badFetch);
  const wrong = { ...render(admission.themeCsp), contentSecurityPolicyMode: 'enforcing' };
  const failures = verifyAdmission(admission, wrong);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /could not be computed/);
});

test('the gate goes red when a recorded hash is missing from the rendered policy', async () => {
  const admission = await admitTheme('http://ghost', ['/'], okFetch);
  const failures = verifyAdmission(admission, render({ kind: 'computed', hashes: [] }));
  assert.ok(failures.length >= 1);
});
