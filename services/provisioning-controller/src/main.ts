import { parseArgs } from 'node:util';
import { commandHostPorts, childEnvironment, type Env } from './commandHost.js';
import { ApprovalRequiredError, ApprovalScopeError } from './errors.js';
import { executeOnboarding } from './executeOnboarding.js';
import type { Clock, ConsoleReporter, ExecutePorts, RunOptions } from './executePorts.js';
import { FileApprovalLedger, FileRegisterReader } from './fileReaders.js';
import { FileStateStore } from './fileStateStore.js';
import { redactSecrets } from './redact.js';
import { parseRunConfig, RunConfigError } from './runConfig.js';
import { readTrustedJson, TrustedFileError } from './trustedFile.js';

/** What the caller sees: 0 the run is complete, 1 it stopped, 2 the approval refused it, 3 bad input, 4 anything else. */
export const EXIT = { complete: 0, stopped: 1, refused: 2, usage: 3, failed: 4 } as const;

export interface CliIo {
  /** One line, the run's result as JSON. */
  readonly stdout: (line: string) => void;
  /** One line per progress event, then one line for an error. */
  readonly stderr: (line: string) => void;
  readonly env: Env;
}

const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MESSAGE_LIMIT = 300;

const systemClock: Clock = {
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const lineConsole = (write: (line: string) => void): ConsoleReporter => ({
  report: async (event) => {
    write(JSON.stringify(event));
  },
});

function describe(e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error';
  const message = e instanceof Error ? e.message : String(e);
  const flat = `${name}: ${message}`.replace(/\p{Cc}+/gu, ' ');
  return redactSecrets(flat).slice(0, MESSAGE_LIMIT);
}

/**
 * The controller's one entry: `--config <file> --approval-id <id>`. The
 * approval id is the only per-run input; everything else comes from the
 * configuration, the recorded approvals, the register and the state file. It
 * runs that one approval to done or to the step that stopped it, prints the
 * result as one JSON line, and exits with a status that says which.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let configPath: string;
  let approvalId: string;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { config: { type: 'string' }, 'approval-id': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    const config = values['config'];
    const approval = values['approval-id'];
    if (config === undefined || approval === undefined) {
      throw new Error('both --config and --approval-id are required');
    }
    if (!APPROVAL_ID.test(approval)) throw new Error('--approval-id is not a plain identifier');
    configPath = config;
    approvalId = approval;
  } catch (e) {
    io.stderr(JSON.stringify({ error: 'UsageError', message: describe(e) }));
    return EXIT.usage;
  }

  let ports: ExecutePorts;
  let options: RunOptions;
  try {
    const config = parseRunConfig(await readTrustedJson(configPath));
    ports = {
      approvals: new FileApprovalLedger(config.approvalsFile),
      register: new FileRegisterReader(config.registerFile),
      hosts: commandHostPorts(config.hosts, childEnvironment(io.env)),
      state: new FileStateStore(config.stateFile),
      console: lineConsole(io.stderr),
      clock: systemClock,
    };
    options = {
      ...(config.retry !== undefined && { retry: config.retry }),
      ...(config.reportTimeoutMs !== undefined && { reportTimeoutMs: config.reportTimeoutMs }),
    };
  } catch (e) {
    const bad = e instanceof RunConfigError || e instanceof TrustedFileError;
    io.stderr(JSON.stringify({ error: bad ? (e as Error).name : 'Error', message: describe(e) }));
    return EXIT.usage;
  }

  try {
    const result = await executeOnboarding(approvalId, ports, options);
    io.stdout(JSON.stringify(result));
    return result.status === 'complete' ? EXIT.complete : EXIT.stopped;
  } catch (e) {
    io.stderr(JSON.stringify({ error: (e as Error).name, message: describe(e) }));
    return e instanceof ApprovalRequiredError || e instanceof ApprovalScopeError
      ? EXIT.refused
      : EXIT.failed;
  }
}
