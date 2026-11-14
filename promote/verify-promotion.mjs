#!/usr/bin/env node
// Verifies the stored promotion attestation on an image digest, the way a host
// will, and prints nothing it has not checked. Two reads (the GitHub API and
// the registry's own bundle), each with every identity flag fixed and the
// predicate type named, then a wrong signer that must be refused for its
// identity. Usage and what is checked: ./README.md.
//
//   node promote/verify-promotion.mjs --image ghcr.io/o/n@sha256:HEX \
//     --repo o/r --signer-workflow o/r/.github/workflows/f.yml \
//     --version v6.66.0 --from-version v6.65.0
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PREDICATE_TYPE, checkPredicate } from './shape.mjs';

const IMAGE_REF = /^[a-z0-9][a-z0-9.-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@(sha256:[0-9a-f]{64})$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// The wording gh prints when the signer identity does not match. A network,
// token or Sigstore fault prints none of it and must fail, not pass as a refusal.
const IDENTITY_REFUSAL =
  /no matching CertificateIdentity|Subject Alternative Name|Policy verification failed/;

/** Runs `gh` with an argv list, never a shell. */
export function runGh(args, env = process.env) {
  const r = spawnSync('gh', args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ghArgs(ref, repo, signer, viaRegistry) {
  return [
    'attestation',
    'verify',
    `oci://${ref}`,
    '--repo',
    repo,
    '--signer-workflow',
    signer,
    '--source-ref',
    'refs/heads/main',
    '--cert-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '--deny-self-hosted-runners',
    '--predicate-type',
    PREDICATE_TYPE,
    '--format',
    'json',
    ...(viaRegistry ? ['--bundle-from-oci'] : []),
  ];
}

/**
 * The statements gh verified, each only if its predicate type, subject digest
 * and predicate all agree with what was asked for. Returns the predicate of the
 * first one that does, or a refusal.
 */
export function readVerified(stdout, { digest, version, fromVersion }) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'verify-output-unreadable', detail: 'gh printed no JSON' };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reason: 'no-verified-statement', detail: 'gh verified no statement' };
  }
  let last = { ok: false, reason: 'no-verified-statement', detail: 'no statement matched' };
  for (const row of rows) {
    const statement = row?.verificationResult?.statement;
    if (statement?.predicateType !== PREDICATE_TYPE) continue;
    const subjects = Array.isArray(statement.subject) ? statement.subject : [];
    if (subjects.length !== 1 || `sha256:${subjects[0]?.digest?.sha256}` !== digest) {
      last = {
        ok: false,
        reason: 'subject-mismatch',
        detail: 'the statement is for another digest',
      };
      continue;
    }
    const verdict = checkPredicate(statement.predicate, { digest, version, fromVersion });
    if (verdict.ok) return { ok: true, predicate: statement.predicate };
    last = verdict;
  }
  return last;
}

/**
 * Pure apart from `run`. Exit-code style result: { ok } or { ok: false, reason }.
 * Both reads must verify, and the wrong signer must be refused for its identity.
 */
export function verifyPromotion(
  { image, repo, signerWorkflow, version, fromVersion },
  run = runGh
) {
  const match = IMAGE_REF.exec(image ?? '');
  if (!match) {
    return { ok: false, reason: 'image-not-a-digest', detail: 'name the image by digest' };
  }
  const digest = match[2];
  if (!REPO.test(repo ?? '')) return { ok: false, reason: 'repo-malformed', detail: repo };
  if (!(signerWorkflow ?? '').startsWith(`${repo}/.github/workflows/`)) {
    return { ok: false, reason: 'signer-outside-repo', detail: signerWorkflow };
  }

  let predicate;
  for (const viaRegistry of [false, true]) {
    const got = run(ghArgs(image, repo, signerWorkflow, viaRegistry));
    if (got.status !== 0) {
      return {
        ok: false,
        reason: viaRegistry ? 'registry-verify-failed' : 'api-verify-failed',
        detail: got.stderr.slice(-400),
      };
    }
    const read = readVerified(got.stdout, { digest, version, fromVersion });
    if (!read.ok) return read;
    predicate = read.predicate;
  }

  // The control. The same command, a signer that never signed this, through both
  // reads: it must fail, and fail for the identity.
  for (const viaRegistry of [false, true]) {
    const got = run(ghArgs(image, repo, `${signerWorkflow}.sabotage`, viaRegistry));
    if (got.status === 0) {
      return { ok: false, reason: 'control-accepted', detail: 'a wrong identity verified' };
    }
    if (!IDENTITY_REFUSAL.test(got.stderr)) {
      return {
        ok: false,
        reason: 'control-failed-for-another-reason',
        detail: got.stderr.slice(-400),
      };
    }
  }
  return { ok: true, predicate };
}

// Only a read that did not come back is worth another look: a fresh attestation
// can take a moment to reach the API and the registry. A refusal on content
// (another digest, release or route) and a control failure are never retried.
const RETRYABLE = new Set(['api-verify-failed', 'registry-verify-failed', 'no-verified-statement']);
export const ATTEMPTS = 5;

const pause = (seconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

export function verifyWithRetry(ask, run = runGh, sleep = pause) {
  let verdict;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    verdict = verifyPromotion(ask, run);
    if (verdict.ok || !RETRYABLE.has(verdict.reason) || attempt === ATTEMPTS) return verdict;
    sleep(attempt * 12);
  }
  return verdict;
}

export function main(
  argv,
  write = (line) => process.stdout.write(`${line}\n`),
  run = runGh,
  sleep = pause
) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) {
      process.stderr.write('promote verify-promotion: expected --name value pairs\n');
      return 1;
    }
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['image', 'repo', 'signer-workflow', 'version', 'from-version']) {
    if (!flags[k]) {
      process.stderr.write(`promote verify-promotion: missing --${k}\n`);
      return 1;
    }
  }
  const verdict = verifyWithRetry(
    {
      image: flags.image,
      repo: flags.repo,
      signerWorkflow: flags['signer-workflow'],
      version: flags.version,
      fromVersion: flags['from-version'],
    },
    run,
    sleep
  );
  if (!verdict.ok) {
    write(`REFUSED ${verdict.reason}: ${verdict.detail}`);
    return 2;
  }
  write(`VERIFIED ${flags.image} route=${verdict.predicate.route}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
