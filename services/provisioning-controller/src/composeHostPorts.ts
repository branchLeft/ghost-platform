import { commandHostPorts, type Env } from './commandHost.js';
import type { HostPorts } from './executePorts.js';
import type { RunConfig } from './runConfig.js';
import { ControllerHost } from './controllerHost.js';
import { SlotDeployHost } from './slotDeployHost.js';
import type { SlotKeys } from './slotKeys.js';
import { SshEntryTransport, hopConfigProblems } from './sshEntryTransport.js';
import { TenantEntryHost, type TenantEntryInputs } from './tenantEntryHost.js';

/**
 * The composition root's choice of host ports. By default every entry point is a configured
 * program (or a refusal). Only when the configuration has an `sshEntry` section does the app host
 * become the tenant entry adapter over the ssh transport, with the configured program as its
 * fallback for the steps it does not serve (the first deploy runs over the slot's own key, and the
 * controller makes that key). There is no default host and no default key path:
 * without the section nothing about ssh is read, checked or started.
 */

/** The deployment's sources the adapter needs and the configuration cannot hold: values, never a secret path. */
export interface HostComposition {
  /** Where the tenant entry adapter gets the secrets template and values, the stack parameters and the deploy key. */
  readonly tenantEntryInputs?: TenantEntryInputs;
  /** Where the controller makes the slot deploy key pair and reads it back; needed with `sshEntry`. */
  readonly slotKeys?: SlotKeys;
}

/** The run must not start: the ssh entry point is configured and something about it is not usable. */
export class SshEntryStartupError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The ssh entry point is not usable: ${problems.join('; ')}.`);
    this.name = 'SshEntryStartupError';
  }
}

/**
 * Builds the run's host ports. When `sshEntry` is configured this asks the real ssh client what it
 * would apply to every hop (`hopConfigProblems`) before anything is built, and throws
 * `SshEntryStartupError` on any problem, so no approval is run over a hop that is not pinned.
 */
export async function composeHostPorts(
  config: RunConfig,
  env: Env,
  composition: HostComposition = {}
): Promise<HostPorts> {
  const commands = commandHostPorts(config.hosts, env);
  const ssh = config.sshEntry;
  if (ssh === undefined) return commands;

  const problems = await hopConfigProblems(ssh, env);
  if (problems.length > 0) throw new SshEntryStartupError(problems);
  if (composition.tenantEntryInputs === undefined) {
    throw new SshEntryStartupError([
      'no source of the tenant entry inputs (secrets, stack parameters, deploy key) is available',
    ]);
  }
  if (composition.slotKeys === undefined) {
    throw new SshEntryStartupError(['no place to make and keep the slot deploy keys is available']);
  }
  const transport = new SshEntryTransport(ssh, env);
  return {
    ...commands,
    // The controller makes the slot key itself; its other steps keep their configured program.
    controller: new ControllerHost(composition.slotKeys, commands['controller']),
    // The entry verbs first, then the first deploy over the slot's own key, then the program.
    'app-host': new TenantEntryHost({
      transport,
      inputs: composition.tenantEntryInputs,
      fallback: new SlotDeployHost({
        transport,
        keys: composition.slotKeys,
        fallback: commands['app-host'],
      }),
    }),
  };
}
