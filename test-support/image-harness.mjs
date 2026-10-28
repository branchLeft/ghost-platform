// Shared plumbing for the image tests that boot the built Ghost image in the
// required `docker build` job (sso, scanning-storage, export-bundler). See
// image-harness.md for why each piece exists. Node built-ins only: the
// callers need no install.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- ports

const PORT_MIN = 20_000;
const PORT_MAX = 29_999;
// Ports this process has claimed. A claim is held until exit, so a port is
// never handed out twice by one process.
const held = new Set();
let exitHookInstalled = false;

// IMAGE_HARNESS_PORT_DIR exists so the self-test can use a private registry.
const registryDir = () =>
  process.env.IMAGE_HARNESS_PORT_DIR ?? path.join(os.tmpdir(), 'bl-image-test-ports');
const claimDir = (port) => path.join(registryDir(), String(port));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A claim directory is made before its pid file is written, and the file is
// created empty before the pid lands in it; a claim younger than this whose
// pid is missing, empty or unreadable is a claim in the middle of being made.
const CLAIM_GRACE_MS = 30_000;

function claimIsStale(dir) {
  let pid = Number.NaN;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(dir, 'pid'), 'utf8'), 10);
  } catch {
    // no pid file yet, or an unreadable one: judged by age below
  }
  if (Number.isInteger(pid)) return !pidAlive(pid);
  const made = fs.statSync(dir, { throwIfNoEntry: false });
  // A directory that has vanished is no claim at all; the caller retries its mkdir.
  return made === undefined || Date.now() - made.mtimeMs > CLAIM_GRACE_MS;
}

// Moving the directory aside is atomic, so of two processes reaping the same
// dead claim only one wins; the loser simply retries its own mkdir.
function reap(dir) {
  const aside = `${dir}.reaped-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return;
  }
  fs.rmSync(aside, { recursive: true, force: true });
}

/** Claims `port` in the cross-process registry. False if a live process holds it. */
export function claimPort(port) {
  fs.mkdirSync(registryDir(), { recursive: true });
  const dir = claimDir(port);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!claimIsStale(dir)) return false;
      reap(dir);
    }
  }
  return false;
}

export function releasePort(port) {
  held.delete(port);
  fs.rmSync(claimDir(port), { recursive: true, force: true });
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      server.close(() => resolve(true))
    );
  });
}

/**
 * A host port no other live process holds, claimed before it is published to
 * Docker. The range sits below the OS ephemeral ranges and Docker's dynamic
 * one, so nothing else allocates there behind the registry's back.
 */
export async function reservePort() {
  const span = PORT_MAX - PORT_MIN + 1;
  const first = crypto.randomInt(span);
  for (let i = 0; i < span; i += 1) {
    const port = PORT_MIN + ((first + i) % span);
    if (held.has(port) || !claimPort(port)) continue;
    if (!(await canBind(port))) {
      releasePort(port);
      continue;
    }
    held.add(port);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.on('exit', () => {
        for (const p of held) fs.rmSync(claimDir(p), { recursive: true, force: true });
      });
    }
    return port;
  }
  throw new Error(`reservePort: no free port in ${PORT_MIN}-${PORT_MAX}`);
}

// --------------------------------------------------------------- docker

const MAX_STDERR_BYTES = 400;
const MAX_ARG_CHARS = 120;

// `-e NAME=value` carries configuration (sometimes a throwaway credential).
// Reads the pairs in `-e NAME=v`, `--env NAME=v`, `--env=NAME=v` and `-eNAME=v`.
function splitEnv(args) {
  const rest = [];
  const envs = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    const joined = /^(?:--env=|-e)(\w+=.*)$/s.exec(arg);
    if ((arg === '-e' || arg === '--env') && /^\w+=/.test(String(args[i + 1] ?? ''))) {
      envs.push(String(args[i + 1]));
      i += 1;
    } else if (joined) {
      envs.push(joined[1]);
    } else {
      rest.push(arg);
    }
  }
  return { rest, envs };
}

// The argv with the `-e` pairs counted, not echoed, for the error message.
function describeArgv(args) {
  const { rest, envs } = splitEnv(args);
  const shown = rest.map((a) => (a.length > MAX_ARG_CHARS ? `${a.slice(0, MAX_ARG_CHARS)}...` : a));
  if (envs.length > 0) shown.push(`(and ${envs.length} -e variables, values not shown)`);
  return shown.join(' ');
}

// The argv with each `-e` pair kept by name and its value replaced, for the cause.
function namedArgv(args) {
  const { rest, envs } = splitEnv(args);
  const named = envs.map((pair) => `-e ${pair.slice(0, pair.indexOf('='))}=<redacted>`);
  return [...rest, ...named].join(' ');
}

// Text from docker can echo the argv back (usage errors do), so every `NAME=value`
// pair goes, and a bare value of 8 or more characters too.
function redactEnv(text, envs) {
  let out = text;
  for (const pair of envs) {
    out = out.split(pair).join(`${pair.slice(0, pair.indexOf('='))}=<redacted>`);
    const value = pair.slice(pair.indexOf('=') + 1);
    if (value.length >= 8) out = out.split(value).join('<redacted>');
  }
  return out;
}

export class DockerStepError extends Error {
  constructor(step, args, raw) {
    const { envs } = splitEnv(args);
    const stderr = Buffer.from(redactEnv(String(raw.stderr ?? ''), envs))
      .subarray(0, MAX_STDERR_BYTES)
      .toString('utf8')
      .trim();
    const exit = raw.status ?? raw.code ?? 'unknown';
    // The raw execFileSync error is not kept: its message is the whole command
    // line, `-e` values included, and reporters print the cause chain. This
    // copy carries the same facts with the values replaced.
    const cause = new Error(`Command failed: docker ${namedArgv(args)}\n${stderr}`);
    cause.status = raw.status ?? null;
    cause.signal = raw.signal ?? null;
    if (raw.code) cause.code = raw.code;
    super(`${step} failed (exit ${exit})\nstderr: ${stderr}\nargv: docker ${describeArgv(args)}`, {
      cause,
    });
    this.name = 'DockerStepError';
    this.step = step;
    this.exitCode = raw.status ?? null;
    this.stderr = stderr;
  }
}

/** Runs docker and returns stdout; a failure names `step`, the argv, the exit code and stderr. */
export function dockerSync(step, ...args) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new DockerStepError(step, args, err);
  }
}

/** dockerSync with the step named after the docker verb, e.g. "docker create". */
export function docker(...args) {
  return dockerSync(`docker ${args[0]}`, ...args);
}

// ---------------------------------------------------------------- steps

/**
 * Runs one setup step so that it can only end by resolving or by rejecting
 * with its own name on the error. A promise that is never settled, with
 * nothing left to keep the event loop alive, makes node:test cancel every
 * test below it with no error of its own; the deadline timer is ref'd, so
 * the loop stays alive until the step settles or this rejects.
 */
export async function runStep(name, fn, { deadlineMs = 180_000 } = {}) {
  let timer;
  const deadlineError = new Error(`setup step "${name}" did not settle in ${deadlineMs}ms`);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(deadlineError), deadlineMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(fn), deadline]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const named =
      err === deadlineError
        ? err
        : new Error(`setup step "${name}" failed: ${detail}`, { cause: err });
    // node:test reports a failed hook after the cancelled tests under it;
    // saying it here as well puts the cause above them in the log.
    process.stderr.write(`SETUP FAILED: ${named.message}\n`);
    throw named;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- poll

const logToStderr = (line) => process.stderr.write(`${line}\n`);

function containerState(containerName) {
  const out = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', containerName], {
    encoding: 'utf8',
  });
  if (out.error || out.status !== 0) {
    return { running: false, text: `inspect failed: ${(out.error?.message ?? out.stderr).trim()}` };
  }
  const running = out.stdout.trim();
  return { running: running === 'true', text: `Running=${running}` };
}

/**
 * Polls until `url` answers 200. Every attempt runs under its own abort
 * timer, so one hung attempt is logged by name and the poll goes on. When
 * `containerName` is given, a container that has stopped ends the poll early.
 * Never throws: the result is { ok, detail }, where `detail` carries the last
 * error and the container's state for the caller's failure message.
 * `probe(signal)` replaces the default fetch, for callers that must send a
 * particular Host header; it resolves to an HTTP status.
 */
export async function pollHttp200(
  url,
  {
    containerName,
    deadlineMs = 90_000,
    attemptMs = 5_000,
    sleepMs = 500,
    probe = (signal) => fetch(url, { signal }).then((res) => res.status),
    log = logToStderr,
  } = {}
) {
  const label = containerName ? `${url} (${containerName})` : url;
  const deadline = Date.now() + deadlineMs;
  let attempts = 0;
  let lastError = 'no attempt completed';
  let state = containerName ? 'not checked' : 'no container named';
  while (Date.now() < deadline) {
    attempts += 1;
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`attempt did not settle in ${attemptMs}ms`));
      }, attemptMs);
    });
    try {
      const status = await Promise.race([probe(controller.signal), timedOut]);
      if (status === 200) return { ok: true, detail: `answered 200 on attempt ${attempts}` };
      lastError = `HTTP ${status}`;
    } catch (err) {
      lastError = err.cause?.code ?? err.message;
      if (/did not settle/.test(err.message)) {
        log(`pollHttp200: ${label}: attempt ${attempts} ${err.message}; continuing`);
      }
    } finally {
      clearTimeout(timer);
    }
    if (containerName) {
      const s = containerState(containerName);
      state = s.text;
      if (!s.running) {
        return {
          ok: false,
          detail: `container stopped after ${attempts} attempt(s); last error: ${lastError}; ${state}`,
        };
      }
    }
    await sleep(sleepMs);
  }
  return {
    ok: false,
    detail: `no 200 from ${url} in ${deadlineMs}ms (${attempts} attempt(s)); last error: ${lastError}; ${state}`,
  };
}
