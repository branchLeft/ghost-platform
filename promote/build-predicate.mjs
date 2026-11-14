#!/usr/bin/env node
// Builds the promotion predicate for one candidate digest from the two records
// it rests on, recomputing every verdict from the raw records and trusting none
// of their own summaries. Usage, exit codes and fields: ./README.md.
//
//   node promote/build-predicate.mjs --digest sha256:HEX --version v6.66.0 \
//     --from-version v6.65.0 --policy-file FILE --steps FILE --gate-report FILE \
//     --from-commit SHA --to-commit SHA --out FILE
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyReport } from '../gate-set/gate-set.mjs';
import { assertReleaseReversible } from '../services/release-classifier/src/gate.mjs';
import { PREDICATE_TYPE, ROUTE, SCHEMA } from './shape.mjs';

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export { PREDICATE_TYPE };

const gateRows = (report) =>
  Array.isArray(report?.results)
    ? report.results.map((r) => ({ name: String(r?.name), ok: r?.ok === true }))
    : [];

/**
 * Pure. record: the JSON the steps CLI printed (or anything, which is then
 * refused as unreadable). gateReport: the record the gate set wrote for this
 * digest (or anything). Input that cannot be recorded at all (a malformed
 * digest, tag, hash or commit) throws RangeError and no predicate exists;
 * every other failure is a consent predicate that names its reason.
 */
export function buildPredicate({
  digest,
  version,
  fromVersion,
  policySha256,
  record,
  gateReport,
  fromCommit,
  toCommit,
}) {
  if (!DIGEST.test(digest ?? '')) throw new RangeError('digest is not sha256:<64 hex>');
  if (!RELEASE_TAG.test(version ?? '') || !RELEASE_TAG.test(fromVersion ?? '')) {
    throw new RangeError('version and from-version must be plain release tags');
  }
  if (version === fromVersion) throw new RangeError('version and from-version are the same');
  if (!/^[0-9a-f]{64}$/.test(policySha256 ?? '')) {
    throw new RangeError('the policy hash is not a sha256');
  }
  if (!COMMIT.test(fromCommit ?? '') || !COMMIT.test(toCommit ?? '')) {
    throw new RangeError('the source commits are not 40 hex characters');
  }

  const classification = assertReleaseReversible(record, {
    pinned: fromVersion,
    target: version,
  });
  const gates = verifyReport(gateReport, { digest });
  const refusals = [
    ...(classification.ok
      ? []
      : [
          {
            source: 'classification',
            reason: classification.reason,
            detail: classification.detail,
          },
        ]),
    ...(gates.ok ? [] : [{ source: 'gates', reason: gates.reason, detail: gates.detail }]),
  ];

  return {
    schema: SCHEMA,
    digest,
    version,
    fromVersion,
    route: refusals.length === 0 ? ROUTE.FAST_PATH : ROUTE.CONSENT,
    policySha256,
    classification: {
      ok: classification.ok,
      schema: typeof record?.schema === 'string' ? record.schema : null,
      class: typeof record?.class === 'string' ? record.class : null,
      sources: { fromCommit, toCommit },
    },
    gates: { ok: gates.ok, results: gateRows(gateReport) },
    refusals,
  };
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) {
      throw new TypeError(`expected --name value pairs; got: ${argv.join(' ')}`);
    }
    flags[key.slice(2)] = argv[i + 1];
  }
  for (const k of [
    'digest',
    'version',
    'from-version',
    'policy-file',
    'steps',
    'gate-report',
    'from-commit',
    'to-commit',
    'out',
  ]) {
    if (!flags[k]) throw new TypeError(`missing --${k}`);
  }
  return flags;
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Exit 0: a predicate was written, fast-path or consent (the route is in it).
 * Exit 1: the input cannot be recorded, nothing is written, and nothing may be
 * signed. An unreadable or unparsable steps or gate record is not exit 1: it
 * is a consent predicate, because a hold is the safe reading of a missing record.
 */
export function main(argv, write = (line) => process.stdout.write(`${line}\n`)) {
  let predicate;
  let flags;
  try {
    flags = parseFlags(argv);
    const policySha256 = createHash('sha256')
      .update(fs.readFileSync(flags['policy-file']))
      .digest('hex');
    predicate = buildPredicate({
      digest: flags.digest,
      version: flags.version,
      fromVersion: flags['from-version'],
      policySha256,
      record: readJsonOrNull(flags.steps),
      gateReport: readJsonOrNull(flags['gate-report']),
      fromCommit: flags['from-commit'],
      toCommit: flags['to-commit'],
    });
  } catch (err) {
    process.stderr.write(`promote build-predicate: ${err.message}\n`);
    return 1;
  }
  fs.writeFileSync(flags.out, `${JSON.stringify(predicate, null, 2)}\n`);
  write(`ROUTE ${predicate.route} digest=${predicate.digest}`);
  for (const r of predicate.refusals) write(`REFUSED ${r.source} ${r.reason}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
