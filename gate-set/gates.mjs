// The six real gates. Each is one existing check run against the candidate
// image; this file adds no verdict logic of its own except the overlay check.
// A gate passes only when every command it runs exits 0. Which command stands
// behind which gate, and what is not covered: gate-set/README.md.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TAIL_BYTES = 4000;

/**
 * Runs argv with no shell, streams its output to this process, and resolves
 * with the exit code and the last bytes of what it printed. A command that
 * cannot start resolves with code 127.
 */
export function spawnExec(argv, { cwd, env = {} } = {}) {
  return new Promise((resolve) => {
    let tail = '';
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString('utf8')).slice(-TAIL_BYTES);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => resolve({ code: 127, output: String(error.message) }));
    child.on('close', (code) => resolve({ code: code ?? 1, output: tail }));
  });
}

const GHOST_ROOT = '/var/lib/ghost/current/core/server';

// Files the Dockerfile overlays or moves aside. `pin` names the committed
// sha256 file holding the expected bytes; `repoFile` names a committed file
// whose own hash is the expected bytes.
export const OVERLAYS = [
  {
    name: 'session-from-token',
    imagePath: `${GHOST_ROOT}/services/auth/session/session-from-token.js`,
    pin: 'adapters/sso/ghost-core-overlay/session-from-token.patched.sha256',
  },
  {
    name: 'stripe-connect-limit',
    imagePath: `${GHOST_ROOT}/models/settings.js`,
    pin: 'adapters/stripe-connect-limit/ghost-core-overlay/stripe-connect-limit.patched.sha256',
  },
  {
    name: 'theme-storage-upstream',
    imagePath: `${GHOST_ROOT}/services/themes/theme-storage.upstream.js`,
    pin: 'adapters/scanning-storage/ghost-core-overlay/theme-storage.upstream.sha256',
  },
  {
    name: 'theme-storage-overlay',
    imagePath: `${GHOST_ROOT}/services/themes/theme-storage.js`,
    repoFile: 'adapters/scanning-storage/ghost-core-overlay/theme-storage.js',
  },
];

const SHA256_LINE = /^([0-9a-f]{64})\s/;

/**
 * The expected sha256 of each overlaid file, read from the committed pins.
 * Throws when a pin file does not hold a sha256, so a damaged pin is a red
 * gate and never an empty comparison.
 */
export function expectedOverlayHashes(repoRoot, readFile = fs.readFileSync) {
  return OVERLAYS.map((overlay) => {
    if (overlay.repoFile) {
      const bytes = readFile(path.join(repoRoot, overlay.repoFile));
      return { ...overlay, expected: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
    const match = SHA256_LINE.exec(readFile(path.join(repoRoot, overlay.pin), 'utf8'));
    if (!match) throw new Error(`${overlay.pin} does not hold a sha256`);
    return { ...overlay, expected: match[1] };
  });
}

/**
 * Compares what the image holds with what the pins say. Returns the problems;
 * empty means every overlaid file is the pinned bytes.
 */
export function judgeOverlays(expected, sha256sumOutput) {
  const observed = new Map();
  for (const line of sha256sumOutput.split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\S.*)$/.exec(line.trim());
    if (match) observed.set(match[2], match[1]);
  }
  const problems = [];
  for (const overlay of expected) {
    const found = observed.get(overlay.imagePath);
    if (found === undefined) problems.push(`${overlay.name}: not in the image`);
    else if (found !== overlay.expected)
      problems.push(`${overlay.name}: bytes differ from the pin`);
  }
  return problems;
}

const commandsOk = (runs) => runs.every((run) => run.code === 0);
const tailOf = (runs) => runs.map((run) => run.output).join('\n');

/**
 * The six gates, in the order REQUIRED_GATES names them. `exec` is the
 * command runner (default: a real process); tests pass a recorder.
 */
export function realGates({ repoRoot, exec = spawnExec, readFile = fs.readFileSync }) {
  const at = (...parts) => path.join(repoRoot, ...parts);
  const imageEnv = (image) => ({ IMAGE: image });

  return [
    {
      name: 'overlay-check',
      async run({ image }) {
        const expected = expectedOverlayHashes(repoRoot, readFile);
        const overlayRun = await exec(
          [
            'docker',
            'run',
            '--rm',
            '--entrypoint',
            'sha256sum',
            image,
            ...expected.map((overlay) => overlay.imagePath),
          ],
          { cwd: repoRoot }
        );
        if (overlayRun.code !== 0) {
          return { ok: false, detail: `sha256sum in the image failed: ${overlayRun.output}` };
        }
        const problems = judgeOverlays(expected, overlayRun.output);
        return { ok: problems.length === 0, detail: problems.join('; ') };
      },
    },
    {
      name: 'smoke',
      async run({ image }) {
        const smokeRun = await exec(['sh', at('scripts', 'smoke-test.sh'), image], {
          cwd: repoRoot,
        });
        return { ok: smokeRun.code === 0, detail: smokeRun.code === 0 ? '' : smokeRun.output };
      },
    },
    {
      name: 'storage',
      async run({ image }) {
        const guardRun = await exec(['sh', at('scripts', 'test-storage-guard.sh'), image], {
          cwd: repoRoot,
        });
        const storageRun = await exec(['node', '--test', 'test/image/*.image.test.mjs'], {
          cwd: at('adapters', 'scanning-storage'),
          env: imageEnv(image),
        });
        const storageRuns = [guardRun, storageRun];
        return {
          ok: storageRun.code === 0 && guardRun.code === 0,
          detail: commandsOk(storageRuns) ? '' : tailOf(storageRuns),
        };
      },
    },
    {
      name: 'theme-scan',
      async run({ image }) {
        const themeRun = await exec(['node', '--test', 'themes/image/themes.image.test.mjs'], {
          cwd: repoRoot,
          env: imageEnv(image),
        });
        return { ok: themeRun.code === 0, detail: themeRun.code === 0 ? '' : themeRun.output };
      },
    },
    {
      name: 'mail',
      async run({ image }) {
        const mailRun = await exec(['node', at('scripts', 'mail-gate', 'mail-gate.mjs'), image], {
          cwd: repoRoot,
        });
        return { ok: mailRun.code === 0, detail: mailRun.code === 0 ? '' : mailRun.output };
      },
    },
    {
      name: 'content-policy',
      async run({ image }) {
        const policyRun = await exec(['sh', at('csp', 'gate', 'csp-regression-gate.sh'), image], {
          cwd: repoRoot,
        });
        return { ok: policyRun.code === 0, detail: policyRun.code === 0 ? '' : policyRun.output };
      },
    },
  ];
}
