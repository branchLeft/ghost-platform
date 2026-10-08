// Gate: theme CSP hashes (LLD-3 gate-set table, "Theme CSP hashes"; LLD-5
// 05-gate-and-edge.html C3). When a theme is admitted, derive its script-hash
// set (csp/derive/derive-script-hashes.mjs) and record the set -- or the
// report-only flag. The control case: a theme whose hashes cannot be computed
// must NOT produce an enforcing policy, because that blocks the reader's page.
//
// Standalone check (branchLeft/workspace#1251): the slot 0 gate-set runner
// (branchLeft/workspace#1188) has no code yet, so this exports pure
// functions plus a CLI whose exit code is the verdict.
import { deriveThemeCsp } from '../derive/derive-script-hashes.mjs';

export const REPORT_ONLY_FLAG = 'csp-hashes-unavailable';

/**
 * Derives the ThemeCsp for a theme and the record to store with it.
 * An empty computed set is treated as uncomputable: Ghost always emits inline
 * blocks of its own (JSON-LD), so zero found means the derivation saw
 * something other than a rendered theme, and an enforcing `script-src 'self'`
 * would block the theme's own scripts. (Incidental choice, #1251.)
 */
export async function admitTheme(origin, paths, fetchImpl = fetch) {
  const derived = await deriveThemeCsp(origin, paths, fetchImpl);
  if (derived.kind === 'computed' && derived.hashes.length > 0) {
    return {
      themeCsp: derived,
      record: { mode: 'enforcing', hashes: [...derived.hashes], flag: null },
    };
  }
  const reason =
    derived.kind === 'unavailable' ? derived.reason : 'derivation found no inline scripts';
  return {
    themeCsp: { kind: 'unavailable' },
    record: { mode: 'report-only', hashes: [], flag: REPORT_ONLY_FLAG, reason },
  };
}

/**
 * The verdict: does the edge block rendered from `themeCsp` agree with the
 * admission record? Returns a list of failures; empty means the gate holds.
 * `edge` is render-core's EdgeSiteBlock (only the two CSP fields are read).
 */
export function verifyAdmission(admission, edge) {
  const failures = [];
  const { record } = admission;
  if (record.mode === 'report-only') {
    if (edge.contentSecurityPolicyMode !== 'report-only') {
      failures.push(
        `hashes could not be computed (${record.reason}) but the edge renders ${edge.contentSecurityPolicyMode}`
      );
    }
    if (record.flag !== REPORT_ONLY_FLAG) failures.push('report-only record carries no flag');
    return failures;
  }
  if (edge.contentSecurityPolicyMode !== 'enforcing') {
    failures.push(`hashes computed but the edge renders ${edge.contentSecurityPolicyMode}`);
  }
  for (const hash of record.hashes) {
    if (!edge.contentSecurityPolicy.includes(`'${hash}'`)) {
      failures.push(`recorded hash ${hash} missing from the rendered policy`);
    }
  }
  return failures;
}

async function main() {
  const origin = process.env.GHOST_ORIGIN;
  if (!origin) {
    console.error('theme-hash-gate: set GHOST_ORIGIN to a running Ghost origin.');
    process.exit(2);
  }
  const paths = (process.env.CSP_DERIVE_PATHS ?? '/')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const { renderEdgeSiteBlock, CURRENT_SCHEMA_VERSION } =
    await import('../../render-core/dist/index.js');
  const admission = await admitTheme(origin, paths);
  const edge = renderEdgeSiteBlock(
    {
      version: CURRENT_SCHEMA_VERSION,
      kind: 'tenant',
      siteUrl: 'https://theme-gate.platform-domain.example.test',
      hostname: { kind: 'ours', sub: 'theme-gate', gated: false },
      gate: { kind: 'none' },
    },
    {
      platformZone: 'platform-domain.example.test',
      ownedDomains: ['platform-domain.example.test'],
    },
    {
      tmpfsSize: '128m',
      themeCompressedBytes: 1,
      themeEntryUncompressedBytes: 1,
      themeTotalUncompressedBytes: 1,
      edgeRequestBodyMaxSize: '64MiB',
      memoryLimit: '640m',
    },
    admission.themeCsp
  );
  const failures = verifyAdmission(admission, edge);
  console.log(JSON.stringify({ record: admission.record, failures }, null, 2));
  process.exitCode = failures.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
