import { PermanentStepError } from './errors.js';
import type { HostEntryPoint, StepRequest } from './executePorts.js';
import type { SlotKeys } from './slotKeys.js';

/**
 * The first deploy, run over the slot's own forced command. The slot's key (made by the
 * controller, sent once by the entry point's `key` verb) is bound by the host to one stack, so the
 * stack is not named here and cannot be: the only thing the call carries is one image reference on
 * standard input. The host's wrapper verifies the image's attestation before it writes the pin.
 *
 * It serves `first-deploy` and passes every other step to its fallback. The image is the register's
 * digest on the fixed tenant image name; nothing typed at a run reaches it.
 */

/** The tenant image's registry name; the host's register of attested images names the same one. */
export const TENANT_IMAGE = 'ghcr.io/branchleft/ghost-tenant';
/** The account the slot keys are installed under on the app host. */
export const DEPLOY_ACCOUNT = 'deploy';

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** What the deploy call needs from the ssh transport: the program's exit code, or a thrown error. */
export interface DeployTransport {
  deploy(keyFile: string, user: string, image: string): Promise<number>;
}

export interface SlotDeployHostOptions {
  readonly transport: DeployTransport;
  readonly keys: Pick<SlotKeys, 'privateKeyPath'>;
  /** Serves every step but `first-deploy`. */
  readonly fallback: HostEntryPoint;
}

export class SlotDeployHost implements HostEntryPoint {
  constructor(private readonly options: SlotDeployHostOptions) {}

  async run(request: StepRequest): Promise<void> {
    if (request.id !== 'first-deploy') return this.options.fallback.run(request);
    const slot = request.inputs['slot'];
    if (typeof slot !== 'string' || slot === '') {
      throw new PermanentStepError(`step ${request.id} has no slot to act on`);
    }
    const digest = request.inputs['imageDigest'];
    if (typeof digest !== 'string' || !IMAGE_DIGEST.test(digest)) {
      throw new PermanentStepError('the register holds no image digest for the first deploy');
    }
    const keyFile = await this.options.keys.privateKeyPath(slot);
    const code = await this.options.transport.deploy(
      keyFile,
      DEPLOY_ACCOUNT,
      `${TENANT_IMAGE}@${digest}`
    );
    if (code === 0) return;
    // The wrapper exits 1 for a refusal or a failed start it rolled back, and 2 for usage; neither
    // gets better by being repeated. Anything else (sudo, the shell) is tried again.
    if (code === 1 || code === 2) {
      throw new PermanentStepError(
        `the deploy command refused or failed the first deploy (exit ${String(code)}); see the host journal`
      );
    }
    throw new Error(`the deploy command failed (exit ${String(code)})`);
  }
}
