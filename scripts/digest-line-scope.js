// Required check for the digest-only merge route. For a pull request by the
// machine identity named in MACHINE_LOGIN, it refuses any change except the
// tag and digest on the Dockerfile FROM line. Every other author passes
// untouched, and so does every run with no identity configured.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FROM_LINE = /^FROM ([a-z0-9][a-z0-9._/-]*):([A-Za-z0-9._-]+)@sha256:([0-9a-f]{64})$/;

export function parseFromLine(line) {
  const m = FROM_LINE.exec(line);
  return m ? { image: m[1], tag: m[2], digest: m[3] } : null;
}

const SAME_LOGIN = (a, b) => a.toLowerCase() === b.toLowerCase();

// nameStatus: output of `git diff --name-status --no-renames BASE...HEAD`.
// patch: output of `git diff -U0 --no-renames --no-ext-diff BASE...HEAD -- Dockerfile`.
export function evaluate({ author, machineLogin, nameStatus, patch }) {
  if (!machineLogin) {
    return { applies: false, ok: true, problems: [], reason: 'no machine identity configured' };
  }
  if (!author || !SAME_LOGIN(author, machineLogin)) {
    return { applies: false, ok: true, problems: [], reason: 'author is not the machine identity' };
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

  return { applies: true, ok: problems.length === 0, problems };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function main(argv, env) {
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
  const result = evaluate({
    author,
    machineLogin: env.MACHINE_LOGIN ?? '',
    nameStatus: git(['diff', '--name-status', '--no-renames', range]),
    patch: git([
      'diff',
      '-U0',
      '--no-renames',
      '--no-color',
      '--no-ext-diff',
      range,
      '--',
      'Dockerfile',
    ]),
  });
  if (!result.applies) {
    process.stdout.write(`digest-line-scope: PASS (${result.reason})\n`);
    return 0;
  }
  if (result.ok) {
    process.stdout.write(
      'digest-line-scope: PASS (machine identity changed only the FROM tag and digest)\n'
    );
    return 0;
  }
  process.stdout.write('digest-line-scope: REFUSED\n');
  for (const p of result.problems) process.stdout.write(`  - ${p}\n`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
