import { execFile, spawn } from 'node:child_process';
import { childEnvironment, type Env } from './commandHost.js';
import { PermanentStepError } from './errors.js';

/** One forced-command ssh call per request, argument vector only; see the README's SSH section. */

/** The verbs the host program accepts: the closed list a request is checked against. */
export const SSH_ENTRY_VERBS = [
  'status',
  'claim',
  'secrets',
  'stack',
  'enable',
  'key',
  'owner',
] as const;
export type SshEntryVerb = (typeof SSH_ENTRY_VERBS)[number];

/** The one verb the tenant database host's program accepts (`create-tenant-db NAME`). */
export const DB_ENTRY_VERBS = ['create-tenant-db'] as const;

/** What one call returned: the host program's exit code and its two streams. */
export interface SshEntryReply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One account on one host: a hop of the jump chain, or the target. */
export interface SshEndpoint {
  readonly user: string;
  readonly host: string;
  readonly port?: number;
}

/** A deployment's SSH settings for one tenant host. Every value is validated when the transport is made. */
export interface SshEntryConfig {
  /** Absolute path to the private key for the forced command (and, by the ssh config, the hops). */
  readonly keyFile: string;
  /** Absolute path to the pinned known-hosts file: the only source of host keys. */
  readonly knownHostsFile: string;
  /**
   * Absolute path to an ssh config file read with `-F`, for what a hop needs and a command line
   * cannot hand it (a `Host` stanza carrying the hop's key and the pinned file). Omitted:
   * `/dev/null`, so nothing of the user's own is read.
   */
  readonly sshConfigFile?: string;
  /**
   * The hops in the order they are crossed (edge1 to edge-t, from a controller on ops1); empty for a direct host.
   * Any hop needs `sshConfigFile`: ssh gives a hop's own settings from that file, not from the
   * command line.
   */
  readonly jumpHops: readonly SshEndpoint[];
  /** The tenant host and the account its forced command is bound to. */
  readonly target: SshEndpoint;
  /** `ssh` by default, found on the child's PATH; or an absolute path. */
  readonly sshProgram?: string;
  /** The longest one call may take before the client is killed. Default 120 000. */
  readonly timeoutMs?: number;
  /** Seconds ssh may take to connect, each hop included. Default 10. */
  readonly connectTimeoutSeconds?: number;
  /** The most bytes of each of standard output and standard error read. Default 65 536. */
  readonly maxOutputBytes?: number;
  /** The most bytes of JSON sent on standard input. Default 1 048 576. */
  readonly maxPayloadBytes?: number;
}

export type SshTransportFailure =
  | 'invalid-config'
  | 'invalid-request'
  | 'not-startable'
  | 'host-key'
  | 'output-too-large'
  | 'timeout'
  | 'connection'
  | 'signal';

/** A call that did not reach the host program, where trying again can help. */
export class SshTransportError extends Error {
  constructor(
    readonly failure: SshTransportFailure,
    message: string
  ) {
    super(message);
    this.name = 'SshTransportError';
  }
}

/** A call that did not reach the host program, where trying again cannot help: the step fails at once. */
export class SshTransportRefusedError extends PermanentStepError {
  constructor(
    readonly failure: SshTransportFailure,
    message: string
  ) {
    super(message);
    this.name = 'SshTransportRefusedError';
  }
}

export const DEFAULT_SSH_TIMEOUT_MS = 120_000;
export const DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS = 10;
/** A deploy waits for the unit's start (up to 600 s on the host), so it gets a little longer than that. */
export const DEPLOY_TIMEOUT_MS = 660_000;
export const DEFAULT_SSH_MAX_OUTPUT_BYTES = 65_536;
export const DEFAULT_SSH_MAX_PAYLOAD_BYTES = 1_048_576;

/** ssh's own failure status; the host program only ever exits with a small code, so 255 is never its answer. */
const SSH_OWN_FAILURE = 255;

/** The same shape the register holds for a slot; first character alphanumeric, so never an option. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
/** One digest-pinned image reference: a registry name, then `@sha256:` and 64 hex digits. */
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9./_-]{0,200}@sha256:[0-9a-f]{64}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
/** Absolute, no space, no `%` (ssh expands it), no `=`, `,` or quote; made only of path-safe characters. */
const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]+$/;
const HOST_KEY_FAILURE =
  /host key verification failed|remote host identification has changed|no (?:\w+ )?host key is known/i;

const isCount = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

function checkPath(name: string, value: unknown, bad: string[]): void {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.split('/').includes('..')) {
    bad.push(name);
  }
}

function checkEndpoint(name: string, e: SshEndpoint, bad: string[]): void {
  if (typeof e.user !== 'string' || !USER.test(e.user)) bad.push(`${name}.user`);
  if (typeof e.host !== 'string' || !HOST.test(e.host)) bad.push(`${name}.host`);
  if (e.port !== undefined && !isCount(e.port, 1, 65535)) bad.push(`${name}.port`);
}

/** Names the settings a configuration gets wrong; empty means usable. Nothing is guessed. */
export function invalidSshSettings(config: SshEntryConfig): string[] {
  const bad: string[] = [];
  checkPath('keyFile', config.keyFile, bad);
  checkPath('knownHostsFile', config.knownHostsFile, bad);
  if (config.sshConfigFile !== undefined) checkPath('sshConfigFile', config.sshConfigFile, bad);
  if (
    config.sshProgram !== undefined &&
    config.sshProgram !== 'ssh' &&
    !(typeof config.sshProgram === 'string' && SAFE_PATH.test(config.sshProgram))
  ) {
    bad.push('sshProgram');
  }
  if (typeof config.target !== 'object' || config.target === null) bad.push('target');
  else checkEndpoint('target', config.target, bad);
  if (!Array.isArray(config.jumpHops)) bad.push('jumpHops');
  else {
    config.jumpHops.forEach((hop, i) => {
      if (typeof hop !== 'object' || hop === null) bad.push(`jumpHops[${String(i)}]`);
      else checkEndpoint(`jumpHops[${String(i)}]`, hop, bad);
    });
    if (config.jumpHops.length > 0 && config.sshConfigFile === undefined) {
      bad.push('sshConfigFile (required with jumpHops)');
    }
  }
  if (config.timeoutMs !== undefined && !isCount(config.timeoutMs, 1, 600_000)) {
    bad.push('timeoutMs');
  }
  if (
    config.connectTimeoutSeconds !== undefined &&
    !isCount(config.connectTimeoutSeconds, 1, 300)
  ) {
    bad.push('connectTimeoutSeconds');
  }
  if (config.maxOutputBytes !== undefined && !isCount(config.maxOutputBytes, 1, 1_048_576)) {
    bad.push('maxOutputBytes');
  }
  if (config.maxPayloadBytes !== undefined && !isCount(config.maxPayloadBytes, 1, 8_388_608)) {
    bad.push('maxPayloadBytes');
  }
  return bad;
}

const endpointOf = (e: SshEndpoint, withPort: 'colon' | 'none'): string =>
  `${e.user}@${e.host}${withPort === 'colon' && e.port !== undefined ? `:${String(e.port)}` : ''}`;

export class SshEntryTransport {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxPayloadBytes: number;
  private readonly env: Env;

  /** Throws `SshTransportRefusedError('invalid-config')` for a setting that is not usable. */
  constructor(
    private readonly config: SshEntryConfig,
    env: Env = process.env,
    /** The closed list a request's verb is checked against: the app host's by default. */
    private readonly verbs: readonly string[] = SSH_ENTRY_VERBS
  ) {
    const bad = invalidSshSettings(config);
    if (bad.length > 0) {
      throw new SshTransportRefusedError(
        'invalid-config',
        `The ssh transport's settings are unusable: ${bad.join(', ')}.`
      );
    }
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_SSH_MAX_OUTPUT_BYTES;
    this.maxPayloadBytes = config.maxPayloadBytes ?? DEFAULT_SSH_MAX_PAYLOAD_BYTES;
    this.env = childEnvironment(env);
  }

  /**
   * The argument vector for one call, without the program. Exposed so the design is the tested
   * shape; it holds only configuration and the two checked words.
   */
  argvFor(verb: string, slug: string): string[] {
    const c = this.config;
    return [...this.baseArgv(c.keyFile, c.target.user), verb, slug];
  }

  /**
   * The argument vector for a slot's deploy call: the slot's own key, the deploy account, and no
   * command words at all, because the host's forced command for that key names the stack itself.
   */
  deployArgvFor(keyFile: string, user: string): string[] {
    return this.baseArgv(keyFile, user);
  }

  private baseArgv(keyFile: string, user: string): string[] {
    const c = this.config;
    const argv = [
      '-F',
      c.sshConfigFile ?? '/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${c.knownHostsFile}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'LogLevel=ERROR',
      '-o',
      `ConnectTimeout=${String(c.connectTimeoutSeconds ?? DEFAULT_SSH_CONNECT_TIMEOUT_SECONDS)}`,
      '-T',
      '-i',
      keyFile,
    ];
    if (c.target.port !== undefined) argv.push('-p', String(c.target.port));
    if (c.jumpHops.length > 0) {
      argv.push('-J', c.jumpHops.map((hop) => endpointOf(hop, 'colon')).join(','));
    }
    argv.push(endpointOf({ ...c.target, user }, 'none'));
    return argv;
  }

  /**
   * Runs the slot's forced deploy command once: the image reference on standard input and nothing
   * else, through the same hops and pinned host keys as `send`. The key file and the account are
   * checked as the transport checks every path and name; the image must be one digest-pinned
   * reference of one line. Returns the program's exit code; its text is dropped unread, so nothing
   * the host prints is kept.
   */
  deploy(keyFile: string, user: string, image: string): Promise<number> {
    if (!SAFE_PATH.test(keyFile) || keyFile.split('/').includes('..') || !USER.test(user)) {
      return Promise.reject(
        new SshTransportRefusedError('invalid-request', 'The deploy key or account is unusable.')
      );
    }
    if (!IMAGE_REFERENCE.test(image)) {
      return Promise.reject(
        new SshTransportRefusedError(
          'invalid-request',
          'The image is not one digest-pinned reference.'
        )
      );
    }
    return this.run(
      this.deployArgvFor(keyFile, user),
      Buffer.from(`${image}\n`, 'utf8'),
      DEPLOY_TIMEOUT_MS
    ).then((reply) => reply.code);
  }

  /**
   * Runs the host's forced command for `verb slug` once. Anything but a verb on the closed list and
   * a slug of the register's shape is refused before a process is started.
   */
  send(
    verb: string,
    slug: string,
    payload?: Readonly<Record<string, unknown>>
  ): Promise<SshEntryReply> {
    let argv: string[];
    let input: Buffer | undefined;
    try {
      if (!this.verbs.includes(verb)) {
        throw new SshTransportRefusedError(
          'invalid-request',
          'The verb is not one the host accepts.'
        );
      }
      if (typeof slug !== 'string' || !SLUG.test(slug)) {
        throw new SshTransportRefusedError('invalid-request', 'The slug is not a valid slot name.');
      }
      input = this.encode(payload);
      argv = this.argvFor(verb, slug);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('invalid request'));
    }
    return this.run(argv, input);
  }

  private encode(payload: Readonly<Record<string, unknown>> | undefined): Buffer | undefined {
    if (payload === undefined) return undefined;
    let text: string | undefined;
    try {
      text = JSON.stringify(payload);
    } catch {
      text = undefined;
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      text === undefined
    ) {
      throw new SshTransportRefusedError('invalid-request', 'The payload is not one JSON object.');
    }
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > this.maxPayloadBytes) {
      throw new SshTransportRefusedError('invalid-request', 'The payload is larger than allowed.');
    }
    return bytes;
  }

  private run(
    argv: string[],
    input: Buffer | undefined,
    timeoutMs: number = this.timeoutMs
  ): Promise<SshEntryReply> {
    const program = this.config.sshProgram ?? 'ssh';
    const limit = this.maxOutputBytes;
    return new Promise<SshEntryReply>((resolve, reject) => {
      let settled = false;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      const finish = (result: SshEntryReply | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const child = spawn(program, argv, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      });
      const stop = (error: Error): void => {
        child.kill('SIGKILL');
        finish(error);
      };
      const timer = setTimeout(() => {
        stop(
          new SshTransportError(
            'timeout',
            `The host entry point did not answer within ${String(timeoutMs)} ms.`
          )
        );
      }, timeoutMs);
      const tooLarge = (): void => {
        stop(
          new SshTransportRefusedError(
            'output-too-large',
            `The host entry point sent more than ${String(limit)} bytes; the reply is refused.`
          )
        );
      };
      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > limit) tooLarge();
        else out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > limit) tooLarge();
        else err.push(chunk);
      });
      child.once('error', (e: Error & { code?: string }) => {
        const code = e.code ?? 'unknown';
        const cannotHeal = code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC';
        finish(
          cannotHeal
            ? new SshTransportRefusedError(
                'not-startable',
                `The ssh client could not be started (${code}).`
              )
            : new SshTransportError(
                'not-startable',
                `The ssh client could not be started (${code}).`
              )
        );
      });
      child.once('close', (status, signal) => {
        const reply: SshEntryReply = {
          code: status ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        };
        if (status === null) {
          finish(
            new SshTransportError('signal', `The ssh client was ended by ${signal ?? 'a signal'}.`)
          );
        } else if (status === SSH_OWN_FAILURE) {
          // ssh's own failure, so the host program never answered. The pin failing is a stop;
          // anything else (no route, a refused connection, a denied key) is for the retry policy.
          finish(
            HOST_KEY_FAILURE.test(reply.stderr)
              ? new SshTransportRefusedError(
                  'host-key',
                  "The host's key does not match the pinned known-hosts file; nothing was sent."
                )
              : new SshTransportError(
                  'connection',
                  'The ssh client could not reach the host entry point.'
                )
          );
        } else {
          finish(reply);
        }
      });
      // A client that exits without reading its input must not crash the run.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }
}

/**
 * Asks `ssh -G` what the client would apply to each hop and names every setting that is not the
 * pinned one (see the README). Empty means every hop is configured as the target is.
 */
export async function hopConfigProblems(
  config: SshEntryConfig,
  env: Env = process.env
): Promise<string[]> {
  const bad = invalidSshSettings(config);
  if (bad.length > 0) return bad.map((name) => `invalid setting ${name}`);
  const program = config.sshProgram ?? 'ssh';
  const problems: string[] = [];
  for (const [i, hop] of config.jumpHops.entries()) {
    const name = `jumpHops[${String(i)}]`;
    const args = ['-G', '-F', config.sshConfigFile ?? '/dev/null'];
    if (hop.port !== undefined) args.push('-p', String(hop.port));
    args.push('-l', hop.user, hop.host);
    let shown: string;
    try {
      shown = await new Promise<string>((resolve, reject) => {
        execFile(
          program,
          args,
          { env: childEnvironment(env), timeout: 10_000, maxBuffer: 1_048_576 },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error))
        );
      });
    } catch {
      problems.push(`${name}: ssh could not read the configuration`);
      continue;
    }
    const lines = shown.split('\n');
    const has = (line: string): boolean => lines.includes(line);
    if (!has('stricthostkeychecking true'))
      problems.push(`${name}: StrictHostKeyChecking is not yes`);
    if (!has('batchmode yes')) problems.push(`${name}: BatchMode is not yes`);
    if (!has('identitiesonly yes')) problems.push(`${name}: IdentitiesOnly is not yes`);
    if (!has(`userknownhostsfile ${config.knownHostsFile}`)) {
      problems.push(`${name}: UserKnownHostsFile is not the pinned file alone`);
    }
    if (!has('globalknownhostsfile /dev/null')) {
      problems.push(`${name}: GlobalKnownHostsFile is not switched off`);
    }
    if (!has(`identityfile ${config.keyFile}`))
      problems.push(`${name}: IdentityFile is not the key`);
  }
  return problems;
}
