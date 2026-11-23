import { PermanentStepError } from './errors.js';
import type { HostEntryPoint, StepRequest } from './executePorts.js';
import type { SlotKeys } from './slotKeys.js';

/**
 * The controller's own steps that have no program: `register-host-keys` makes the slot's deploy key
 * pair here, in the controller, so no person and no other program ever holds the private half. Every
 * other `controller` step goes to the program the deployment configured for it.
 */
export class ControllerHost implements HostEntryPoint {
  constructor(
    private readonly keys: Pick<SlotKeys, 'ensure'>,
    private readonly fallback: HostEntryPoint
  ) {}

  async run(request: StepRequest): Promise<void> {
    if (request.id !== 'register-host-keys') return this.fallback.run(request);
    const slot = request.inputs['slot'];
    if (typeof slot !== 'string' || slot === '') {
      throw new PermanentStepError(`step ${request.id} has no slot to act on`);
    }
    await this.keys.ensure(slot);
  }
}
