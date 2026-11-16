import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Target } from './target.js';

/** portal/apps, where `dist/<app>/main.js` is run from, as the image's working directory is. */
const APPS_DIR = fileURLToPath(new URL('../../', import.meta.url));
const MOCK_ENTRY = fileURLToPath(
  new URL('../../../../services/provisioning-controller/dist/mock/main.js', import.meta.url)
);

/** The last of a process's output kept for a failure message; never a value the test chose to hide. */
const OUTPUT_KEPT = 8000;

/** One running process the rig started: stop it, or read what it said. */
export interface Running {
  readonly name: string;
  output(): string;
  stop(): Promise<void>;
}

/** A free loopback port: bound, noted, released. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function track(
  name: string,
  child: ChildProcess,
  stopper: () => void
): Running & { exited(): boolean } {
  let output = '';
  let exited = false;
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_KEPT);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', (error) => {
      output += `\n${error.message}`;
      exited = true;
      resolve();
    });
  });
  return {
    name,
    output: () => output,
    exited: () => exited,
    stop: async () => {
      if (!exited) stopper();
      await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
    },
  };
}

/** The provisioning mock, built in `services/provisioning-controller/dist/mock`, as its own process. */
export function startMock(env: Readonly<Record<string, string>>): Running & { exited(): boolean } {
  const child = spawn(process.execPath, [MOCK_ENTRY], { env: { ...env }, stdio: 'pipe' });
  return track('provisioning-mock', child, () => child.kill('SIGTERM'));
}

export type AppName = 'tenant' | 'console';

export interface AppSpec {
  readonly app: AppName;
  readonly port: number;
  /** Every variable the application reads; paths are already as the application sees them. */
  readonly env: Readonly<Record<string, string>>;
  /** The host directory holding the files the variables name; mounted read-only into an image. */
  readonly filesDir: string;
  /** Where `filesDir` appears inside an image. */
  readonly mountPoint: string;
}

/**
 * One application, from the built checkout or from the image. Either way it is
 * `node dist/<app>/main.js` with PORT and its own variables and nothing else:
 * the image runs on the host network, so the loopback addresses the rig hands
 * out (the identity provider, the provisioning mock, the mail double, the
 * database) are the same for it as for a process on the host.
 */
export function startApp(target: Target, spec: AppSpec): Running & { exited(): boolean } {
  const env = { ...spec.env, PORT: String(spec.port) };
  if (target.kind === 'dist') {
    const child = spawn(process.execPath, [`dist/${spec.app}/main.js`], {
      cwd: APPS_DIR,
      env,
      stdio: 'pipe',
    });
    return track(spec.app, child, () => child.kill('SIGTERM'));
  }
  const name = `journey-${spec.app}-${String(process.pid)}-${String(spec.port)}`;
  const variables = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'host',
      '--volume',
      `${spec.filesDir}:${spec.mountPoint}:ro`,
      ...variables,
      target.reference,
      'node',
      `dist/${spec.app}/main.js`,
    ],
    { stdio: 'pipe' }
  );
  const stopper = (): void => {
    spawn('docker', ['stop', '--time', '3', name], { stdio: 'ignore' }).on(
      'error',
      () => undefined
    );
  };
  return track(spec.app, child, stopper);
}

/** Resolves once the origin answers HTTP at all; rejects with the process's own output when it dies first. */
export async function waitUntilServing(
  origin: string,
  process_: Running & { exited(): boolean },
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (process_.exited()) {
      throw new Error(`${process_.name} stopped before it served:\n${process_.output()}`);
    }
    try {
      await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`${process_.name} did not serve ${origin} in time:\n${process_.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
