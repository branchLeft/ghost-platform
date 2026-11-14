// The per-digest gate set. One candidate digest runs six gates, and what each
// one found is written down against that digest, so the attestation step can
// refuse a candidate whose record is red, incomplete or for another digest.
// Narrative, report shape and exit codes: gate-set/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPORT_SCHEMA = 'branchleft-gate-report/1';
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Cheapest first. A candidate must have exactly these results in its record.
export const REQUIRED_GATES = [
  'overlay-check',
  'smoke',
  'storage',
  'theme-scan',
  'mail',
  'content-policy',
];

const DETAIL_LIMIT = 600;
const clip = (text) => String(text ?? '').slice(-DETAIL_LIMIT);

/**
 * The digest the first FROM line pins, or null when it is not pinned by digest.
 */
export function digestFromDockerfile(text) {
  const from = /^FROM\s+(?:--\S+\s+)*(\S+)/im.exec(text);
  if (!from) return null;
  const pinned = /@(sha256:[0-9a-f]{64})$/.exec(from[1]);
  return pinned ? pinned[1] : null;
}

export function reportFileName(digest) {
  if (!DIGEST_PATTERN.test(digest)) throw new RangeError('not a sha256 digest');
  return `gate-report-${digest.slice('sha256:'.length)}.json`;
}

/**
 * Runs every required gate, then any extra gate, in order, and returns the
 * record. A gate is `{ name, run(ctx) }` and passes only by returning
 * `{ ok: true }`: a throw, a missing gate and any other return are red. Never
 * throws for a red gate; throws for input that cannot be recorded (a digest
 * that is not sha256, or two gates with one name).
 */
export async function runGateSet({ gates, image, digest, source = 'argument', now = Date.now }) {
  if (!DIGEST_PATTERN.test(digest)) throw new RangeError('digest is not sha256:<64 hex>');
  if (typeof image !== 'string' || image.length === 0) throw new RangeError('image is empty');
  const byName = new Map();
  for (const gate of gates) {
    if (byName.has(gate.name)) throw new RangeError(`two gates are named ${gate.name}`);
    byName.set(gate.name, gate);
  }
  const names = [
    ...REQUIRED_GATES,
    ...[...byName.keys()].filter((n) => !REQUIRED_GATES.includes(n)),
  ];
  const startedAt = now();
  const results = [];
  for (const name of names) {
    const gate = byName.get(name);
    if (!gate) {
      results.push({ name, ok: false, durationMs: 0, detail: 'gate is not wired' });
      continue;
    }
    const began = now();
    let ok = false;
    let detail = '';
    try {
      const outcome = await gate.run({ image, digest });
      ok = outcome?.ok === true;
      detail = clip(outcome?.detail);
    } catch (error) {
      detail = clip(`threw: ${error?.message ?? error}`);
    }
    results.push({ name, ok, durationMs: now() - began, detail });
  }
  return {
    schema: REPORT_SCHEMA,
    digest,
    image,
    source,
    startedAt: new Date(startedAt).toISOString(),
    totalMs: now() - startedAt,
    ok: results.every((result) => result.ok === true),
    results,
  };
}

/**
 * The verdict the attestation step takes from a record. It recomputes from the
 * results and never reads the record's own `ok`, so an edited summary changes
 * nothing. Green needs the record to be for this digest, to hold each required
 * gate exactly once, and every result (extras included) to be `ok: true`.
 */
export function verifyReport(report, { digest }) {
  if (!DIGEST_PATTERN.test(digest ?? '')) {
    return {
      ok: false,
      reason: 'gate-digest-mismatch',
      detail: 'the release digest is not sha256',
    };
  }
  if (!report || report.schema !== REPORT_SCHEMA || !Array.isArray(report.results)) {
    return { ok: false, reason: 'gate-report-malformed', detail: 'not a gate report' };
  }
  if (report.digest !== digest) {
    return {
      ok: false,
      reason: 'gate-digest-mismatch',
      detail: 'the gate report is not for the release digest',
    };
  }
  const missing = REQUIRED_GATES.filter(
    (name) => report.results.filter((result) => result?.name === name).length !== 1
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'gate-missing',
      detail: `missing or repeated: ${missing.join(', ')}`,
    };
  }
  const red = report.results.filter((result) => result?.ok !== true).map((result) => result?.name);
  if (red.length > 0) {
    return { ok: false, reason: 'gate-red', detail: `red gates: ${red.join(', ')}` };
  }
  return { ok: true };
}

const USAGE =
  'usage: gate-set.mjs run --image REF (--digest sha256:HEX | --dockerfile PATH) [--out DIR_OR_FILE]\n' +
  '       gate-set.mjs verify --report FILE --digest sha256:HEX';

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key?.startsWith('--') || args[i + 1] === undefined) return null;
    flags[key.slice(2)] = args[i + 1];
  }
  return flags;
}

/**
 * The CLI, with its collaborators passed in. Returns the exit code:
 * 0 green, 1 red or refused, 2 the command line or input could not be used.
 */
export async function main(argv, deps) {
  const { gates, out = (line) => console.log(line), cwd = process.cwd(), now = Date.now } = deps;
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!flags || (command !== 'run' && command !== 'verify')) {
    out(USAGE);
    return 2;
  }

  if (command === 'verify') {
    if (!flags.report || !flags.digest) {
      out(USAGE);
      return 2;
    }
    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.resolve(cwd, flags.report), 'utf8'));
    } catch (error) {
      out(`REFUSED gate-report-unreadable: ${error.message}`);
      return 1;
    }
    const verdict = verifyReport(report, { digest: flags.digest });
    out(verdict.ok ? 'GATE REPORT GREEN' : `REFUSED ${verdict.reason}: ${verdict.detail}`);
    return verdict.ok ? 0 : 1;
  }

  if (!flags.image || (!flags.digest && !flags.dockerfile) || (flags.digest && flags.dockerfile)) {
    out(USAGE);
    return 2;
  }
  let digest = flags.digest;
  let source = 'argument';
  if (flags.dockerfile) {
    digest = digestFromDockerfile(fs.readFileSync(path.resolve(cwd, flags.dockerfile), 'utf8'));
    source = 'dockerfile';
    if (!digest) {
      out('REFUSED the Dockerfile FROM line is not pinned by sha256 digest');
      return 1;
    }
  }
  let report;
  try {
    report = await runGateSet({ gates, image: flags.image, digest, source, now });
  } catch (error) {
    out(`ERROR ${error.message}`);
    return 2;
  }
  const target = path.resolve(cwd, flags.out ?? '.');
  const file =
    fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, reportFileName(digest))
      : target;
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  for (const result of report.results) {
    out(
      `${result.ok ? 'GREEN' : 'RED  '} ${result.name} ${result.durationMs}ms ${result.detail}`.trimEnd()
    );
  }
  out(
    `GATE_SET ${report.ok ? 'GREEN' : 'RED'} digest=${digest} totalMs=${report.totalMs} report=${file}`
  );
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { realGates } = await import('./gates.mjs');
  const repoRoot = path.resolve(import.meta.dirname, '..');
  process.exit(await main(process.argv.slice(2), { gates: realGates({ repoRoot }) }));
}
