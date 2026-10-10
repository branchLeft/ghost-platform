import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, '../../scripts');
const WRAPPER = path.join(SCRIPTS, 'host/branchleft-break-glass.sh');
const SERVICE = path.join(SCRIPTS, 'systemd/branchleft-break-glass-expire.service');
const TIMER = path.join(SCRIPTS, 'systemd/branchleft-break-glass-expire.timer');
const DRAIN_SIDECAR_DOCKERFILE = path.resolve(
  HERE,
  '../../../../services/drain-sidecar/Dockerfile'
);

const TOOL_DIR = '/usr/local/lib/branchleft/break-glass';
const STATE_DIR = '/var/lib/branchleft/break-glass-grants';
const LOG_DIR = '/var/log/branchleft';
const SOCKET = '/var/run/docker.sock';
const KEY_DIR = '/etc/branchleft/break-glass';
const TOOL = `${TOOL_DIR}/break-glass-grant.mjs`;

/** Flags `docker run` takes a value for, among the ones the tool's start-up uses. */
const VALUED = new Set([
  '--pull',
  '--network',
  '--cap-drop',
  '--security-opt',
  '--pids-limit',
  '--memory',
  '--user',
  '--label',
  '--mount',
  '-e',
  '--env',
  '-v',
  '--volume',
  '--name',
  '--entrypoint',
  '--pid',
  '--ipc',
  '--cap-add',
  '--device',
]);

/** Splits `docker run ...` tokens into its options, the image and the command. */
function parseRun(tokens) {
  expect(tokens.slice(0, 2)).toEqual([expect.stringMatching(/docker$/), 'run']);
  const options = [];
  let i = 2;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (VALUED.has(tokens[i])) {
      options.push([tokens[i], tokens[i + 1]]);
      i += 2;
    } else {
      options.push([tokens[i]]);
      i += 1;
    }
  }
  return { options, image: tokens[i], command: tokens.slice(i + 1) };
}

function serviceTokens() {
  const text = fs.readFileSync(SERVICE, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('ExecStart='));
  let joined = '';
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    joined += `${line.replace(/\\$/, '')} `;
    if (!line.endsWith('\\')) break;
  }
  return joined
    .replace(/^ExecStart=/, '')
    .trim()
    .split(/\s+/);
}

let work;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-wrap-'));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

/**
 * Runs the real wrapper with a fake `docker` that records its argv (NUL
 * separated) and a fake `systemctl` that exits `timerExit`. Nothing here
 * starts a container.
 */
function runWrapper(args, { timerExit = 0, withSystemctl = true } = {}) {
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const argvFile = path.join(work, 'docker-argv');
  const systemctlFile = path.join(work, 'systemctl-argv');
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}'\nexit 0\n`,
    { mode: 0o755 }
  );
  if (withSystemctl) {
    fs.writeFileSync(
      path.join(bin, 'systemctl'),
      `#!/bin/sh\nprintf '%s\\0' "$@" > '${systemctlFile}'\nexit ${timerExit}\n`,
      { mode: 0o755 }
    );
  }
  const result = spawnSync('/bin/sh', [WRAPPER, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin` },
  });
  const read = (file) =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\0').slice(0, -1) : null;
  return { result, docker: read(argvFile), systemctl: read(systemctlFile) };
}

const PASSTHROUGH = [
  'grant',
  '--lane',
  'incident',
  '--tenant',
  'tenant-zero',
  '--reason',
  'a reason; with $(punctuation) and "quotes"',
  '--reference',
  'ref',
];

describe('the host wrapper', () => {
  it('starts exactly one container, with the pinned image and the tool as its command', () => {
    const { result, docker } = runWrapper(PASSTHROUGH);
    expect(result.status).toBe(0);
    const run = parseRun(['docker', ...docker]);
    expect(run.image).toMatch(/^node:26\.5\.0-bookworm-slim@sha256:[a-f0-9]{64}$/);
    expect(run.command).toEqual(['node', TOOL, ...PASSTHROUGH]);
  });

  it('pins the same Node image as the other places the estate runs it', () => {
    const dockerfile = fs.readFileSync(DRAIN_SIDECAR_DOCKERFILE, 'utf8');
    const pinned = /^FROM (node:\S+@sha256:[a-f0-9]{64})/m.exec(dockerfile)[1];
    const { docker } = runWrapper(['status']);
    expect(parseRun(['docker', ...docker]).image).toBe(pinned);
    expect(parseRun(serviceTokens()).image).toBe(pinned);
  });

  it('passes the operator arguments through untouched, after the image', () => {
    const { docker } = runWrapper(['revoke', '--tenant', 't', '--reason', '--rm; --network host']);
    const run = parseRun(['docker', ...docker]);
    expect(run.command.slice(-5)).toEqual([
      'revoke',
      '--tenant',
      't',
      '--reason',
      '--rm; --network host',
    ]);
    expect(run.options.filter(([flag]) => flag === '--network')).toEqual([['--network', 'none']]);
  });

  it('gives the container no network, no new privileges, no capabilities and a read-only root', () => {
    const { docker } = runWrapper(['status']);
    const { options } = parseRun(['docker', ...docker]);
    const has = (...option) => options.some((o) => JSON.stringify(o) === JSON.stringify(option));
    expect(has('--network', 'none')).toBe(true);
    expect(has('--cap-drop', 'ALL')).toBe(true);
    expect(has('--security-opt', 'no-new-privileges')).toBe(true);
    expect(has('--read-only')).toBe(true);
    expect(has('--rm')).toBe(true);
    expect(has('--pull', 'never')).toBe(true);
    expect(has('--privileged')).toBe(false);
    expect(options.map(([flag]) => flag)).not.toEqual(
      expect.arrayContaining(['--cap-add', '--device', '--pid', '--ipc', '--volume', '-v'])
    );
  });

  it('mounts the tool read-only, the grant state, the grant log and the Engine socket, and nothing else', () => {
    const { docker } = runWrapper(['status']);
    const mounts = parseRun(['docker', ...docker])
      .options.filter(([flag]) => flag === '--mount')
      .map(([, value]) => value);
    expect(mounts).toEqual([
      `type=bind,source=${TOOL_DIR},target=${TOOL_DIR},readonly`,
      `type=bind,source=${STATE_DIR},target=${STATE_DIR}`,
      `type=bind,source=${LOG_DIR},target=${LOG_DIR}`,
      `type=bind,source=${SOCKET},target=${SOCKET}`,
    ]);
    expect(mounts.join(' ')).not.toContain(KEY_DIR);
  });

  it('asks systemd whether the expire timer is active, and passes the answer in as env', () => {
    const active = runWrapper(['status'], { timerExit: 0 });
    expect(active.systemctl).toEqual([
      'is-active',
      '--quiet',
      'branchleft-break-glass-expire.timer',
    ]);
    expect(parseRun(['docker', ...active.docker]).options).toContainEqual([
      '-e',
      'BL_EXPIRE_TIMER_STATE=active',
    ]);
  });

  it('reports the timer inactive when systemd says so', () => {
    const { docker } = runWrapper(['status'], { timerExit: 3 });
    expect(parseRun(['docker', ...docker]).options).toContainEqual([
      '-e',
      'BL_EXPIRE_TIMER_STATE=inactive',
    ]);
  });

  it('reports the timer inactive when systemctl cannot be run at all', () => {
    const { docker } = runWrapper(['status'], { withSystemctl: false });
    expect(parseRun(['docker', ...docker]).options).toContainEqual([
      '-e',
      'BL_EXPIRE_TIMER_STATE=inactive',
    ]);
  });

  it('passes no value from the caller environment into the container', () => {
    const bin = path.join(work, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const argvFile = path.join(work, 'argv');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}'\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    spawnSync('/bin/sh', [WRAPPER, 'status'], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        BL_EXPIRE_TIMER_STATE: 'forged',
        IMAGE: 'attacker/image',
        TOOL_DIR: '/tmp/evil',
      },
    });
    const argv = fs.readFileSync(argvFile, 'utf8');
    expect(argv).not.toContain('forged');
    expect(argv).not.toContain('attacker');
    expect(argv).not.toContain('/tmp/evil');
  });
});

describe('the expire unit', () => {
  it('runs the tool in the container itself, not on the host Node', () => {
    const tokens = serviceTokens();
    expect(tokens[0]).toBe('/usr/bin/docker');
    expect(tokens.join(' ')).not.toMatch(/\/usr\/bin\/env|^node /);
    const run = parseRun(tokens);
    expect(run.command).toEqual(['node', TOOL, 'expire']);
  });

  it('starts the container with exactly the options the wrapper uses, bar the timer state', () => {
    const wrapper = parseRun(['docker', ...runWrapper(['status']).docker]);
    const unit = parseRun(serviceTokens());
    const withoutEnv = (options) => options.filter(([flag]) => flag !== '-e');
    expect(withoutEnv(unit.options)).toEqual(withoutEnv(wrapper.options));
    expect(unit.image).toBe(wrapper.image);
    expect(unit.options.filter(([flag]) => flag === '-e')).toEqual([]);
  });

  it('is bounded, and ordered after Docker', () => {
    const text = fs.readFileSync(SERVICE, 'utf8');
    expect(text).toMatch(/^TimeoutStartSec=10min$/m);
    expect(text).toMatch(/^After=docker\.service$/m);
    expect(text).toMatch(/^Type=oneshot$/m);
  });

  it('is fired every minute, and a missed minute runs at boot', () => {
    const text = fs.readFileSync(TIMER, 'utf8');
    expect(text).toMatch(/^OnCalendar=minutely$/m);
    expect(text).toMatch(/^Persistent=true$/m);
    expect(text).toMatch(/^WantedBy=timers\.target$/m);
  });
});

describe('what no file here may hold', () => {
  it.each([
    ['the wrapper', WRAPPER],
    ['the unit', SERVICE],
  ])('%s names no signing key, token or admin URL', (_name, file) => {
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(KEY_DIR);
    expect(text).not.toMatch(/signing-key|bl_break_glass|BEGIN .*PRIVATE|https?:\/\//i);
  });
});
