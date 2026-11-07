// A pull request starts a path-filtered workflow only when its diff touches a
// path in the filter. A file the workflow reads but the filter does not name is
// a silent skip: the change lands, the check never runs, and nothing is red.
// This reads every workflow with a `paths:` filter, works out what it reads,
// and fails for any read the filter does not cover. See
// workflow-paths-cover-reads.md for the rules, the exemptions and the limits.
//
// `findUncoveredReads` is one pure function: the real tree is checked by the
// first test, and the sabotage tests below run the same function on an
// in-memory copy of a real workflow with one filter line removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const FILTERED_EVENTS = ['pull_request', 'pull_request_target', 'push'];
const SOURCE_FILE = /\.(?:js|mjs|cjs|ts|mts|cts|tsx|py|sh)$/;
const TEST_COMMAND = /\b(?:test|tests|vitest|jest|pytest|unittest|coverage)\b/;
const VERSION_FILE_KEYS = ['node-version-file', 'python-version-file', 'cache-dependency-path'];
// `docker build` flags that take their value as the next word.
const DOCKER_VALUE_FLAGS = new Set([
  '-f',
  '--file',
  '-t',
  '--tag',
  '--secret',
  '--platform',
  '--build-arg',
  '--target',
  '--cache-from',
  '--cache-to',
  '-o',
  '--output',
  '--label',
  '--network',
  '--progress',
  '--provenance',
  '--sbom',
  '--add-host',
  '--iidfile',
]);

// Reads a static scan cannot see (a path held in a variable, or built at run
// time). Each entry names a workflow and a tracked file, and says why. An
// entry that names an unknown workflow or an untracked file fails, and so does
// one the scan now finds by itself.
const DECLARED_READS = {
  'infra-provisioning-scripts-ci.yml': [
    {
      path: 'RUNBOOK-tenant-onboarding.md',
      why: 'test_runbook_names_match_workflow.py and test_host_key_register.py read it through a variable',
    },
  ],
};

// Reads that are real in the source but never run by the filtered workflow.
// `reader` is a path prefix. An exemption that no longer hides a finding
// fails, so this cannot grow into a blanket ignore.
const EXEMPT = [
  {
    workflow: 'export-bundler-ci.yml',
    reader: 'services/export-bundler/test/image/',
    reason:
      'image-harness tests: the package vitest include excludes test/image; they run only in build.yml, which is unfiltered',
  },
  {
    workflow: 'scanning-storage-ci.yml',
    reader: 'adapters/scanning-storage/test/',
    reason:
      'image-harness tests and helper: the package vitest include is test/unit only (and the unit tests do not read the harness); the image tests run only in build.yml, which is unfiltered',
  },
  {
    workflow: 'broker-release.yml',
    reader: 'services/broker/test/live/',
    reason:
      'live proof: skipped unless the host has a local Ghost image, which the runner never has (its skipped branch asserts that)',
  },
  {
    workflow: 'sso-adapter-ci.yml',
    reader: 'adapters/sso/test/image/',
    reason:
      'image-harness tests: the package vitest include excludes test/image; they run only in build.yml, which is unfiltered',
  },
];

// ---------------------------------------------------------------- filters --

function unquote(value) {
  const v = value.replace(/\s+#.*$/, '').trim();
  const m = v.match(/^(['"])(.*)\1$/);
  return m ? m[2] : v;
}

function isBlankOrComment(line) {
  return /^\s*(#.*)?$/.test(line);
}

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

// The `on:` block, read line-wise. Returns the line range and, per event, the
// `paths:` list (an event with no `paths:` is unfiltered and absent).
export function parseFilters(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  const result = { filters: {}, unsupported: [], range: null };
  if (start < 0) return result;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !lines[i].startsWith('#')) {
      end = i;
      break;
    }
  }
  result.range = [start, end];
  let event = null;
  let key = null;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    let m;
    if (indent === 2 && (m = line.match(/^ {2}([a-z_]+):/))) {
      event = m[1];
      key = null;
    } else if (indent === 4 && (m = line.match(/^ {4}([a-z-]+):\s*(.*)$/))) {
      key = m[1];
      if (key === 'paths-ignore') result.unsupported.push(`${event}: paths-ignore`);
      if (key === 'paths') {
        result.filters[event] = [];
        const inline = m[2].replace(/\s+#.*$/, '').trim();
        if (inline.startsWith('[')) {
          const items = inline.replace(/^\[|\]$/g, '').split(',');
          result.filters[event].push(...items.map(unquote).filter(Boolean));
        }
      }
    } else if (indent >= 6 && key === 'paths' && (m = line.match(/^\s+-\s+(.*)$/))) {
      result.filters[event].push(unquote(m[1]));
    }
  }
  return result;
}

// GitHub filter glob: `*` and `?`-less segments stay inside one path segment,
// `**` crosses `/`, `?` is zero or one of the preceding character, `+` is one
// or more of it.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length;) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      re += '[^/]*';
      i += 1;
    } else if (c === '?' || c === '+') {
      re += c;
      i += 1;
    } else if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close > i) {
        re += glob.slice(i, close + 1);
        i = close + 1;
      } else {
        re += '\\[';
        i += 1;
      }
    } else {
      re += c.replace(/[.\\^$|(){}]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

// Patterns apply in order and the last match wins; `!` negates.
export function matchesFilter(patterns, file) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(file)) included = false;
    } else if (globToRegExp(pattern).test(file)) {
      included = true;
    }
  }
  return included;
}

// ------------------------------------------------------------------ steps --

// Every step of every job: its working directory, its `run` text, the rest of
// its text, and the `with:` values that name files. Line-wise, like the other
// root workflow tests.
export function parseSteps(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return [];
  let jobsEnd = lines.length;
  const jobStarts = [];
  for (let n = jobsAt + 1; n < lines.length; n++) {
    if (/^\S/.test(lines[n]) && !lines[n].startsWith('#')) {
      jobsEnd = n;
      break;
    }
    const m = lines[n].match(/^ {2}([\w-]+):\s*$/);
    if (m) jobStarts.push(n);
  }
  const steps = [];
  jobStarts.forEach((jobStart, j) => {
    const jobEnd = j + 1 < jobStarts.length ? jobStarts[j + 1] : jobsEnd;
    let jobCwd = '.';
    const defaultsAt = lines.slice(jobStart, jobEnd).findIndex((l) => /^ {4}defaults:\s*$/.test(l));
    if (defaultsAt >= 0) {
      for (let n = jobStart + defaultsAt + 1; n < jobEnd; n++) {
        if (!isBlankOrComment(lines[n]) && indentOf(lines[n]) <= 4) break;
        const m = lines[n].match(/^ {8}working-directory:\s*(.+?)\s*$/);
        if (m) jobCwd = unquote(m[1]);
      }
    }
    const stepsAt = lines.slice(jobStart, jobEnd).findIndex((l) => /^ {4}steps:\s*$/.test(l));
    if (stepsAt < 0) return;
    const first = jobStart + stepsAt + 1;
    let dash = null;
    const starts = [];
    let end = jobEnd;
    for (let n = first; n < jobEnd; n++) {
      if (isBlankOrComment(lines[n])) continue;
      if (dash === null) dash = indentOf(lines[n]);
      if (indentOf(lines[n]) < dash) {
        end = n;
        break;
      }
      if (indentOf(lines[n]) === dash && lines[n].trimStart().startsWith('- ')) starts.push(n);
    }
    starts.forEach((s, k) => {
      steps.push(readStep(lines, s, k + 1 < starts.length ? starts[k + 1] : end, dash + 2, jobCwd));
    });
  });
  return steps;
}

function readStep(lines, start, end, keyIndent, jobCwd) {
  const own = lines.slice(start, end);
  own[0] = own[0].replace(/^(\s*)- /, '$1  ');
  const step = { start, end, cwd: jobCwd, runText: '', otherText: '', withValues: {} };
  const other = [];
  let section = null;
  let blockKey = null;
  own.forEach((line) => {
    if (isBlankOrComment(line)) return;
    const indent = indentOf(line);
    const key = indent === keyIndent ? line.match(/^\s*([\w-]+):\s*(.*)$/) : null;
    if (key) {
      section = key[1];
      blockKey = null;
      const value = key[2].replace(/\s+#.*$/, '').trim();
      if (section === 'run') {
        if (/^[|>][+-]?$/.test(value)) return;
        step.runText += `${value}\n`;
        return;
      }
      if (section === 'working-directory') {
        const cwd = unquote(value);
        if (!cwd.includes('${{')) step.cwd = path.posix.normalize(cwd);
        return;
      }
      other.push(line);
      return;
    }
    if (section === 'run') {
      step.runText += `${line.trim()}\n`;
      return;
    }
    other.push(line);
    if (section === 'with') {
      const sub = indent === keyIndent + 2 ? line.match(/^\s*([\w-]+):\s*(.*)$/) : null;
      if (sub) {
        blockKey = VERSION_FILE_KEYS.includes(sub[1]) ? sub[1] : null;
        const value = sub[2].replace(/\s+#.*$/, '').trim();
        if (blockKey && value && !/^[|>][+-]?$/.test(value)) {
          (step.withValues[blockKey] ??= []).push(unquote(value));
        }
      } else if (blockKey && indent > keyIndent + 2) {
        (step.withValues[blockKey] ??= []).push(unquote(line.trim()));
      }
    }
  });
  step.otherText = other.join('\n');
  return step;
}

// ----------------------------------------------------------------- reads --

function splitWords(line) {
  return [...line.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) =>
    m[0].replace(/^(["'])(.*)\1$/, '$2')
  );
}

// `docker build` commands in a `run` block: the context and the Dockerfile,
// both relative to the step's working directory.
export function dockerBuilds(runText, cwd) {
  const builds = [];
  for (const raw of runText.replace(/\\\n\s*/g, ' ').split('\n')) {
    if (raw.trimStart().startsWith('#')) continue;
    const m = raw.match(/\bdocker\s+(?:buildx\s+)?build\s+(.*)$/);
    if (!m) continue;
    const words = splitWords(m[1].split(/&&|\|\||;|\|/)[0]);
    let file = null;
    const positional = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.startsWith('-')) {
        const eq = w.indexOf('=');
        const name = eq < 0 ? w : w.slice(0, eq);
        let value = eq < 0 ? null : w.slice(eq + 1);
        if (eq < 0 && DOCKER_VALUE_FLAGS.has(w)) value = words[++i];
        if (name === '-f' || name === '--file') file = value;
      } else {
        positional.push(w);
      }
    }
    const context = positional[positional.length - 1];
    if (!context || /[$]|:\/\//.test(context) || (file && /[$]/.test(file))) continue;
    const contextDir = path.posix.normalize(path.posix.join(cwd, context));
    const dockerfile = file
      ? path.posix.normalize(path.posix.join(cwd, file))
      : path.posix.join(contextDir, 'Dockerfile');
    if (contextDir.startsWith('..') || dockerfile.startsWith('..')) continue;
    builds.push({ contextDir, dockerfile });
  }
  return builds;
}

// COPY/ADD sources of a Dockerfile, as written. `--from=` copies from another
// stage or image and reads nothing from the context.
export function copySources(dockerfileText) {
  const sources = [];
  for (const line of dockerfileText.replace(/\\\r?\n/g, ' ').split('\n')) {
    const m = line.match(/^\s*(?:COPY|ADD)\s+(.*)$/i);
    if (!m) continue;
    let rest = m[1].trim();
    let fromStage = false;
    while (rest.startsWith('--')) {
      const flag = rest.match(/^(--\S+)\s*/);
      if (flag[1].startsWith('--from')) fromStage = true;
      rest = rest.slice(flag[0].length);
    }
    if (fromStage || rest.startsWith('<<')) continue;
    let words;
    if (rest.startsWith('[')) {
      try {
        words = JSON.parse(rest);
      } catch {
        continue;
      }
    } else {
      words = splitWords(rest);
    }
    sources.push(...words.slice(0, -1).filter((s) => !/[$]|:\/\//.test(s)));
  }
  return sources;
}

// Tracked files a path or glob names: a file itself, or every file under a
// directory. Docker globs: `*` and `?` stay inside one path segment.
function expandSource(source, tracked, { docker }) {
  if (/[*?[]/.test(source)) {
    const re = docker
      ? new RegExp(
          `^${source
            .replace(/[.+^${}()|\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]')}$`
        )
      : globToRegExp(source);
    return tracked.filter((f) => re.test(f));
  }
  const bare = source.replace(/\/+$/, '');
  if (bare === '' || bare === '.') return tracked;
  return tracked.filter((f) => f === bare || f.startsWith(`${bare}/`));
}

// Upward-relative paths in a source file: runs of string literals joined as a
// path (`join(here, '..', '..', 'x')`, `new URL('../../x', ...)`) that start
// with `..`. The base is a variable we cannot see, so each is tried against
// every ancestor of the reader.
export function upwardPaths(sourceText) {
  const literal = String.raw`(?:'[^'\\\n]*'|"[^"\\\n]*"|` + '`[^`\\\\\\n$]*`)';
  const run = new RegExp(`${literal}(?:\\s*,\\s*${literal})*`, 'g');
  const found = [];
  for (const m of sourceText.matchAll(run)) {
    const parts = [...m[0].matchAll(new RegExp(literal, 'g'))].map((p) => p[0].slice(1, -1));
    const joined = path.posix.normalize(parts.join('/'));
    if (joined.startsWith('../') && joined.replace(/^(?:\.\.\/)+/, '') !== '') found.push(joined);
  }
  return found;
}

function ancestorsOf(dir) {
  const out = [];
  let d = dir;
  for (;;) {
    out.push(d === '.' ? '' : d);
    if (d === '.' || d === '') break;
    d = path.posix.dirname(d);
  }
  return out;
}

// Everything one workflow reads, as { path, why, reader? } records.
function readsOf(text, { tracked, trackedSet, readFile }) {
  const reads = [];
  const add = (p, why, reader) => {
    if (trackedSet.has(p)) reads.push({ path: p, why, reader });
  };
  const steps = parseSteps(text);
  const lines = text.split('\n');
  const { range } = parseFilters(text);

  // Docker build contexts.
  for (const step of steps) {
    for (const { contextDir, dockerfile } of dockerBuilds(step.runText, step.cwd)) {
      add(
        dockerfile,
        `Dockerfile of a docker build in ${step.cwd === '.' ? 'the repo root' : step.cwd}`
      );
      const dockerfileText = trackedSet.has(dockerfile) ? readFile(dockerfile) : undefined;
      for (const source of copySources(dockerfileText ?? '')) {
        const inContext = path.posix.normalize(
          path.posix.join(contextDir, source.replace(/^\//, ''))
        );
        for (const file of expandSource(inContext, tracked, { docker: true })) {
          add(file, `COPY ${source} in ${dockerfile}`);
        }
      }
    }
  }

  // Tracked files named in a step (shell words resolve against the step's
  // working directory; other keys against the repo root) or elsewhere.
  const word = /[\w.@+~/-]+/g;
  const named = (chunk, base, where) => {
    for (const w of chunk.matchAll(word)) {
      const token = w[0].replace(/^(?:\.\/)+/, '').replace(/[.:,]+$/, '');
      // A bare word such as `Dockerfile` in a step name is prose, not a path.
      if (!token || token.startsWith('/') || !/[./]/.test(token)) continue;
      const resolved = path.posix.normalize(path.posix.join(base, token));
      add(resolved, `named in ${where}`);
    }
  };
  const inStep = new Set();
  for (const step of steps) {
    for (let n = step.start; n < step.end; n++) inStep.add(n);
    named(step.runText.replace(/^\s*#.*$/gm, ''), step.cwd, 'a run step');
    named(step.otherText.replace(/^\s*#.*$/gm, ''), '.', 'a step');
  }
  lines.forEach((line, n) => {
    if (inStep.has(n) || (range && n >= range[0] && n < range[1]) || isBlankOrComment(line)) return;
    named(line, '.', 'the workflow');
  });

  // Version and cache keys: a change to one changes what the job installs.
  for (const step of steps) {
    for (const key of VERSION_FILE_KEYS) {
      for (const value of step.withValues[key] ?? []) {
        for (const file of expandSource(value, tracked, { docker: false }))
          add(file, `${key}: ${value}`);
      }
    }
  }

  // Upward reads in the sources of a directory whose tests the workflow runs.
  const testDirs = new Set(
    steps.filter((s) => s.cwd !== '.' && TEST_COMMAND.test(s.runText)).map((s) => s.cwd)
  );
  for (const dir of testDirs) {
    for (const reader of tracked) {
      if (!reader.startsWith(`${dir}/`) || !SOURCE_FILE.test(reader)) continue;
      if (reader.split('/').includes('node_modules')) continue;
      const readerText = readFile(reader);
      if (!readerText) continue;
      for (const up of upwardPaths(readerText)) {
        // The nearest ancestor that makes the path a tracked file is the base.
        for (const base of ancestorsOf(path.posix.dirname(reader))) {
          const target = path.posix.normalize(path.posix.join(base, up));
          if (target.startsWith('..') || !trackedSet.has(target)) continue;
          add(target, `${up} read by ${reader}`, reader);
          break;
        }
      }
    }
  }
  return reads;
}

// ----------------------------------------------------------------- guard --

/**
 * For every workflow whose `pull_request` or `push` trigger filters on
 * `paths:`, every read of that workflow that its filter does not cover.
 *
 * @param {object} args
 * @param {Record<string,string>} args.workflows file name -> text
 * @param {string[]} args.tracked every tracked path in the repo
 * @param {(path: string) => string | undefined} args.readFile
 * @returns {{workflow: string, event: string, path: string, why: string}[]}
 */
export function findUncoveredReads({
  workflows,
  tracked,
  readFile,
  declared = DECLARED_READS,
  exempt = EXEMPT,
}) {
  const trackedSet = new Set(tracked);
  const ctx = { tracked, trackedSet, readFile };
  const findings = [];
  const exemptUsed = new Set();
  const staticReads = {};

  for (const [name, text] of Object.entries(workflows)) {
    const { filters, unsupported } = parseFilters(text);
    for (const u of unsupported) {
      findings.push({
        workflow: name,
        event: u.split(':')[0],
        path: '(filter)',
        why: `unsupported: ${u}`,
      });
    }
    const events = FILTERED_EVENTS.filter((e) => filters[e]);
    if (events.length === 0) continue;
    const reads = readsOf(text, ctx);
    staticReads[name] = new Set(reads.map((r) => r.path));
    for (const read of declared[name] ?? []) {
      reads.push({ path: read.path, why: `declared: ${read.why}` });
    }
    const seen = new Set();
    for (const event of events) {
      for (const read of reads) {
        if (matchesFilter(filters[event], read.path)) continue;
        const hidden = exempt.findIndex(
          (e) => e.workflow === name && read.reader && read.reader.startsWith(e.reader)
        );
        if (hidden >= 0) {
          exemptUsed.add(hidden);
          continue;
        }
        const key = `${event}\0${read.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ workflow: name, event, path: read.path, why: read.why });
      }
    }
  }

  // The two tables check themselves.
  for (const [name, entries] of Object.entries(declared)) {
    for (const entry of entries) {
      const problem = !(name in workflows)
        ? 'names a workflow that does not exist'
        : !trackedSet.has(entry.path)
          ? 'names a file that is not tracked'
          : staticReads[name]?.has(entry.path)
            ? 'is now found by the scan, so the entry is stale'
            : null;
      if (problem) {
        findings.push({
          workflow: name,
          event: '-',
          path: entry.path,
          why: `DECLARED_READS entry ${problem}`,
        });
      }
    }
  }
  exempt.forEach((entry, i) => {
    if (!exemptUsed.has(i)) {
      findings.push({
        workflow: entry.workflow,
        event: '-',
        path: entry.reader,
        why: 'EXEMPT entry hides nothing, so it is stale',
      });
    }
  });
  return findings;
}

// ------------------------------------------------------------------ tests --

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\0')
    .filter(Boolean);
}

function realTree() {
  const tracked = trackedFiles().filter((f) => fs.existsSync(path.join(ROOT, f)));
  const readFile = (p) => {
    try {
      return fs.readFileSync(path.join(ROOT, p), 'utf-8');
    } catch {
      return undefined;
    }
  };
  const workflows = {};
  for (const f of tracked) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)) workflows[path.basename(f)] = readFile(f);
  }
  return { tracked, readFile, workflows };
}

// Removes one `paths:` entry from one event of a workflow's text, and fails if
// there was nothing to remove, so a sabotage case cannot pass vacuously.
function dropFilterEntry(text, event, entry) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l === `  ${event}:`);
  assert.notEqual(at, -1, `no ${event} trigger`);
  for (let i = at + 1; i < lines.length; i++) {
    if (!isBlankOrComment(lines[i]) && indentOf(lines[i]) <= 2) break;
    if (unquote(lines[i].replace(/^\s+-\s+/, '')) === entry && /^\s+-\s/.test(lines[i])) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  assert.fail(`${entry} is not in ${event}.paths`);
}

const tree = realTree();
const real = (extra = {}) => findUncoveredReads({ ...tree, ...extra });

test('every path-filtered workflow filters on every path it reads', () => {
  assert.deepEqual(real(), []);
});

test('sabotage: removing adapters/sso/src/** from drain-sidecar-image names the file the root Dockerfile copies', () => {
  const name = 'drain-sidecar-image.yml';
  const broken = dropFilterEntry(tree.workflows[name], 'pull_request', 'adapters/sso/src/**');
  const found = real({ workflows: { ...tree.workflows, [name]: broken } });
  assert.ok(
    found.some(
      (f) =>
        f.workflow === name &&
        f.event === 'pull_request' &&
        f.path === 'adapters/sso/src/BreakGlassSSO.js' &&
        f.why.startsWith('COPY ')
    ),
    JSON.stringify(found)
  );
  // The same workflow, line restored, is clean.
  assert.deepEqual(real({ workflows: { ...tree.workflows, [name]: tree.workflows[name] } }), []);
});

test('sabotage: removing Dockerfile from sso-adapter-ci reports the vitest global setup that reads it', () => {
  const name = 'sso-adapter-ci.yml';
  const broken = dropFilterEntry(tree.workflows[name], 'pull_request', 'Dockerfile');
  const found = real({ workflows: { ...tree.workflows, [name]: broken } });
  assert.ok(
    found.some(
      (f) =>
        f.workflow === name &&
        f.path === 'Dockerfile' &&
        f.why.includes('adapters/sso/test/unit/global-setup.mjs')
    ),
    JSON.stringify(found)
  );
  assert.deepEqual(real({ workflows: { ...tree.workflows, [name]: tree.workflows[name] } }), []);
});

test('sabotage: removing infra/tenant/runtime.ts from storage-gateway-ci is reported', () => {
  const name = 'storage-gateway-ci.yml';
  const broken = dropFilterEntry(tree.workflows[name], 'pull_request', 'infra/tenant/runtime.ts');
  const found = real({ workflows: { ...tree.workflows, [name]: broken } });
  assert.ok(
    found.some((f) => f.workflow === name && f.path === 'infra/tenant/runtime.ts'),
    JSON.stringify(found)
  );
});

test('a push filter is held to the same standard as the pull_request filter', () => {
  const name = 'node-env-gate-ci.yml';
  const broken = dropFilterEntry(tree.workflows[name], 'push', 'docker-entrypoint.branchleft.sh');
  const found = real({ workflows: { ...tree.workflows, [name]: broken } });
  assert.ok(
    found.some(
      (f) =>
        f.workflow === name && f.event === 'push' && f.path === 'docker-entrypoint.branchleft.sh'
    ),
    JSON.stringify(found)
  );
  assert.ok(!found.some((f) => f.workflow === name && f.event === 'pull_request'));
});

test('a DECLARED_READS entry that names nothing real fails', () => {
  const found = real({
    declared: {
      ...DECLARED_READS,
      'no-such-workflow.yml': [{ path: 'Dockerfile', why: 'x' }],
      'storage-gateway-ci.yml': [{ path: 'no/such/file.txt', why: 'x' }],
      'render-core-ci.yml': [{ path: 'scripts/test-demo-mail-spool.sh', why: 'x' }],
    },
  });
  const problems = found.filter((f) => f.why.startsWith('DECLARED_READS'));
  assert.equal(problems.length, 3, JSON.stringify(found));
});

test('an EXEMPT entry that hides nothing fails', () => {
  const found = real({
    exempt: [
      ...EXEMPT,
      { workflow: 'render-core-ci.yml', reader: 'render-core/src/', reason: 'x' },
    ],
  });
  assert.deepEqual(
    found.map((f) => f.why),
    ['EXEMPT entry hides nothing, so it is stale']
  );
});

test('paths-ignore is reported as unsupported, not read as a filter', () => {
  const text = 'name: x\non:\n  pull_request:\n    paths-ignore:\n      - docs/**\njobs: {}\n';
  const found = findUncoveredReads({
    workflows: { 'x.yml': text },
    tracked: [],
    readFile: () => undefined,
    declared: {},
    exempt: [],
  });
  assert.deepEqual(
    found.map((f) => f.why),
    ['unsupported: pull_request: paths-ignore']
  );
});

test('filter globs follow GitHub: * stays in a segment, ** crosses, ! negates, last match wins', () => {
  assert.ok(matchesFilter(['a/**'], 'a/b/c.js'));
  assert.ok(!matchesFilter(['a/*'], 'a/b/c.js'));
  assert.ok(matchesFilter(['a/*'], 'a/b.js'));
  assert.ok(matchesFilter(['**/x.md'], 'x.md'));
  assert.ok(matchesFilter(['**/x.md'], 'a/b/x.md'));
  assert.ok(!matchesFilter(['a/**', '!a/b/**'], 'a/b/c.js'));
  assert.ok(matchesFilter(['a/**', '!a/b/**', 'a/b/c.js'], 'a/b/c.js'));
  assert.ok(!matchesFilter(['a'], 'a/b'));
});

test('the readers: Dockerfile sources, docker build flags and upward literals', () => {
  assert.deepEqual(
    copySources('COPY --chown=n:n a b /d/\nCOPY --from=x /y /z\nRUN true\nADD ["p", "q"]'),
    ['a', 'b', 'p']
  );
  assert.deepEqual(
    dockerBuilds(
      'docker build \\\n  --secret id=x,env=Y \\\n  -f svc/Dockerfile \\\n  --tag t \\\n  .',
      '.'
    ),
    [{ contextDir: '.', dockerfile: 'svc/Dockerfile' }]
  );
  assert.deepEqual(dockerBuilds('docker build --file Dockerfile --tag t ../..', 'svc/a'), [
    { contextDir: '.', dockerfile: 'svc/a/Dockerfile' },
  ]);
  assert.deepEqual(
    upwardPaths(
      "join(here, '..', '..', 'x', 'y.sh')\nnew URL('../../z.json', import.meta.url)\nimport q from './q.js'"
    ),
    ['../../x/y.sh', '../../z.json']
  );
});
