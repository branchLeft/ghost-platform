// Required check for the digest-only merge route. It runs from the base branch
// and reads the pull request only as git diff data. For a pull request by the
// machine identity named in MACHINE_LOGIN (form: <slug>[bot]), it refuses any
// change except the tag and digest on the Dockerfile FROM line. Every other
// author passes, and so does every run with no identity configured.

import { execFileSync } from 'node:child_process';

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FROM_LINE = /^FROM ([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})$/;
export const IDENTITY_FORM = /^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/;
export const NO_OP_REASON = 'no machine identity configured: this check is a no-op';

export function parseFromLine(line) {
  const m = FROM_LINE.exec(line);
  return m ? { image: m[1], tag: m[2], digest: m[3] } : null;
}

const SAME_LOGIN = (a, b) => a.toLowerCase() === b.toLowerCase();

// nameStatus: output of `git diff --name-status --no-renames BASE...HEAD`.
// patch: output of `git diff -U0 --no-renames --no-ext-diff --no-textconv BASE...HEAD -- Dockerfile`.
export function evaluate({ author, machineLogin, nameStatus, patch }) {
  const identity = (machineLogin ?? '').trim();
  if (!identity) {
    return { applies: false, ok: true, problems: [], identity: '', reason: NO_OP_REASON };
  }
  if (!IDENTITY_FORM.test(identity)) {
    return {
      applies: true,
      ok: false,
      identity,
      problems: [
        `DIGEST_MACHINE_LOGIN must hold exactly <slug>[bot] for an App; found "${identity}". Refusing every pull request until it is fixed.`,
      ],
    };
  }
  if (!author || !author.trim()) {
    return {
      applies: true,
      ok: false,
      identity,
      problems: ['the pull request author could not be read; refusing (fail closed)'],
    };
  }
  if (!SAME_LOGIN(author, identity)) {
    return {
      applies: false,
      ok: true,
      problems: [],
      identity,
      reason: `compared identity ${identity}; author ${author} is not it, check does not apply`,
    };
  }

  const problems = [];
  const files = nameStatus.split('\n').filter(Boolean);
  if (files.length !== 1 || files[0] !== 'M\tDockerfile') {
    problems.push(
      `changed files must be exactly one modified Dockerfile; found: ${files.join(', ') || 'none'}`
    );
  }

  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk);
  for (const l of header) {
    if (
      /^(old mode|new mode|deleted file|new file|rename |copy |Binary files|similarity index)/.test(
        l
      )
    ) {
      problems.push(`Dockerfile header changed: ${l}`);
    }
  }
  const hunks = lines.filter((l) => l.startsWith('@@')).length;
  if (hunks !== 1) {
    problems.push(`Dockerfile must change in exactly one hunk; found ${hunks}`);
  } else {
    const body = lines.slice(firstHunk + 1);
    if (body.length !== 2 || body[0][0] !== '-' || body[1][0] !== '+') {
      problems.push(
        'the hunk must replace exactly one line with exactly one line (no added or context lines)'
      );
    } else {
      const before = parseFromLine(body[0].slice(1));
      const after = parseFromLine(body[1].slice(1));
      if (!before || !after) {
        problems.push('the changed line must be FROM image:tag@sha256:digest, before and after');
      } else if (before.image !== after.image) {
        problems.push(`the image name changed from ${before.image} to ${after.image}`);
      }
    }
  }

  return { applies: true, ok: problems.length === 0, problems, identity };
}

// Writes the summary to the workflow step summary when run in Actions, and
// always to stdout. The no-op is also an annotation, so it cannot pass silently.
function report(lines, env) {
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

export function main(argv, env, cwd = process.cwd()) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? '' : (argv[i + 1] ?? '');
  };
  const base = opt('--base');
  const head = opt('--head');
  const author = opt('--author');
  if (!base || !head) {
    process.stderr.write('usage: digest-line-scope.js --base SHA --head SHA --author LOGIN\n');
    return 2;
  }
  const range = `${base}...${head}`;
  const gitIn = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const result = evaluate({
    author,
    machineLogin: env.MACHINE_LOGIN ?? '',
    nameStatus: gitIn(['diff', '--name-status', '--no-renames', '--no-textconv', range]),
    patch: gitIn([
      'diff',
      '-U0',
      '--no-renames',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      range,
      '--',
      'Dockerfile',
    ]),
  });
  if (!result.applies && !result.identity) {
    process.stdout.write(`::warning title=Digest-only line scope::${NO_OP_REASON}\n`);
    report(
      [
        '### Digest-only line scope',
        '',
        `**${NO_OP_REASON}.** Every pull request passes until DIGEST_MACHINE_LOGIN is set.`,
      ],
      env
    );
    return 0;
  }
  if (!result.applies) {
    report(['### Digest-only line scope', '', `PASS: ${result.reason}.`], env);
    return 0;
  }
  if (result.ok) {
    report(
      [
        '### Digest-only line scope',
        '',
        `PASS: compared identity ${result.identity}; it changed only the FROM tag and digest.`,
      ],
      env
    );
    return 0;
  }
  const out = ['### Digest-only line scope', '', `REFUSED: compared identity ${result.identity}.`];
  for (const p of result.problems) out.push(`- ${p}`);
  report(out, env);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
