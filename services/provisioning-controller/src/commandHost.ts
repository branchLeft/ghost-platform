import { spawn } from 'node:child_process';
import { PermanentStepError } from './errors.js';
import type { HostEntryPoint, HostPorts } from './executePorts.js';
import { ENTRY_POINTS, type EntryPoint } from './plan.js';

/** What a deployment says about one entry point: the program to start, never a shell line. */
export interface CommandSpec {
  /** `argv[0]` is an absolute path to the program; the rest are its arguments, passed as given. */
  readonly argv: readonly string[];
  /** The longest one call may take before the program is killed and the attempt fails. */
  readonly timeoutMs?: number;
}

/** The exit status a host program uses to say retrying cannot help. Every other non-zero status is retried. */
export const HOST_EXIT_PERMANENT = 3;

export const DEFAULT_HOST_TIMEOUT_MS = 120_000;

/** A process environment: names to values. */
export type Env = Readonly<Record<string, string | undefined>>;

/** The only variables a host program inherits: no token, key or agent socket of the controller's reaches it. */
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'LANG'] as const;

export function childEnvironment(env: Env): Env {
  const kept: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

/**
 * Runs one configured program per call and hands it the step on standard
 * input as one JSON object (`key`, `id`, `idempotencyKey`, `inputs`: names and
 * register values, never a secret value). The program's output is discarded
 * unread, so nothing a host prints can reach the state file or the console;
 * the outcome is its exit status alone. Exit 0 is success, `HOST_EXIT_PERMANENT`
 * is a permanent failure, anything else (a signal, a timeout) is retried.
 */
class CommandHost implements HostEntryPoint {
  constructor(
    private readonly entryPoint: EntryPoint,
    private readonly spec: CommandSpec,
    private readonly env: Env
  ) {}

  run(request: Parameters<HostEntryPoint['run']>[0]): Promise<void> {
    const [program = '', ...args] = this.spec.argv;
    const label = `host entry point ${this.entryPoint}`;
    const timeoutMs = this.spec.timeoutMs ?? DEFAULT_HOST_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const child = spawn(program, args, {
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: this.env,
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`${label} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.once('error', (e: Error & { code?: string }) => {
        const code = e.code ?? 'unknown';
        const cannotHeal = code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC';
        finish(
          cannotHeal
            ? new PermanentStepError(`${label} could not be started (${code})`)
            : new Error(`${label} could not be started (${code})`)
        );
      });
      child.once('close', (status, signal) => {
        if (status === 0) finish();
        else if (status === HOST_EXIT_PERMANENT) {
          finish(new PermanentStepError(`${label} refused the step (exit ${status})`));
        } else {
          finish(new Error(`${label} failed (${signal ?? `exit ${String(status)}`})`));
        }
      });
      // A program that exits without reading its input must not crash the run.
      child.stdin.on('error', () => undefined);
      child.stdin.end(
        JSON.stringify({
          key: request.key,
          id: request.id,
          idempotencyKey: request.idempotencyKey,
          inputs: request.inputs,
        })
      );
    });
  }
}

/** An entry point nobody configured: every step that needs it fails at once and acts on nothing. */
class UnconfiguredHost implements HostEntryPoint {
  constructor(private readonly entryPoint: EntryPoint) {}

  run(): Promise<void> {
    return Promise.reject(
      new PermanentStepError(`no host entry point is configured for ${this.entryPoint}`)
    );
  }
}

/** One port per entry point: a configured program, or a refusal. */
export function commandHostPorts(
  specs: Readonly<Partial<Record<EntryPoint, CommandSpec>>>,
  env: Env
): HostPorts {
  const entries = ENTRY_POINTS.map((entryPoint) => {
    const spec = specs[entryPoint];
    const host: HostEntryPoint =
      spec === undefined
        ? new UnconfiguredHost(entryPoint)
        : new CommandHost(entryPoint, spec, env);
    return [entryPoint, host] as const;
  });
  return Object.fromEntries(entries) as unknown as HostPorts;
}
