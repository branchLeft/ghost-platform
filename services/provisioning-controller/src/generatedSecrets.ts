import { randomBytes } from 'node:crypto';
import type { DatabaseHandOver } from './dbHandOver.js';
import { PermanentStepError } from './errors.js';
import type { StepRequest } from './executePorts.js';
import type { EntryClaim, StackParameters, TenantEntryInputs } from './tenantEntryHost.js';

/**
 * The tenant entry inputs with the secrets made by the controller and not by a person. The base
 * inputs supply the template (key names, no values), the stack parameters and the deploy key. For
 * each key the template names, this fills the value:
 *
 * - `GHOST_DB_PASSWORD`: the password db-t1 minted, from the hand-over port. Nothing else is a
 *   source for it, and a value for it in the base's literals is refused.
 * - the object-store keys: placeholder values the controller generates and marks as such, so the
 *   slot starts and uploads are refused until real keys arrive through the storage gateway.
 * - `GHOST_OWNER_EMAIL`: a literal, not a secret, from the base's literals. It is required.
 * - every other key: a fresh value from the operating system's random source.
 *
 * Generated values go to the host on the verb's standard input and are not kept: this class holds
 * none between calls and writes none. After the host confirms the secrets file, `delivered` drops
 * the hand-over copy.
 */

/** The key whose value db-t1 mints. */
export const DATABASE_PASSWORD_KEY = 'GHOST_DB_PASSWORD';
/** Keys that are values and not secrets; the base supplies them and nothing else may be typed in. */
export const LITERAL_KEYS: readonly string[] = ['GHOST_OWNER_EMAIL'];
/** Keys that stand in for credentials the storage gateway will issue. */
export const PLACEHOLDER_KEYS: readonly string[] = [
  'GHOST_S3_ACCESS_KEY_ID',
  'GHOST_S3_SECRET_ACCESS_KEY',
];
/** What marks a generated value as not a real credential. */
export const PLACEHOLDER_PREFIX = 'placeholder-not-a-credential-';

/** A fresh secret: 32 bytes from the operating system's random source, URL-safe. */
export const systemRandom = (): string => randomBytes(32).toString('base64url');

const TEMPLATE_KEY = /^([A-Za-z_][A-Za-z0-9_]*)=$/;

/** The key names of a secrets template: comments and blank lines aside, each line is `KEY=`. */
export function templateKeys(template: string): string[] {
  const names: string[] = [];
  for (const line of template.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const name = TEMPLATE_KEY.exec(line)?.[1];
    if (name === undefined) {
      throw new PermanentStepError('the secrets template has a line the controller cannot fill');
    }
    if (names.includes(name)) {
      throw new PermanentStepError(`the secrets template names ${name} twice`);
    }
    names.push(name);
  }
  if (names.length === 0) throw new PermanentStepError('the secrets template names no key');
  return names;
}

function slotOf(request: StepRequest): string {
  const slot = request.inputs['slot'];
  if (typeof slot !== 'string' || slot === '') {
    throw new PermanentStepError(`step ${request.id} has no slot to act on`);
  }
  return slot;
}

export class GeneratedTenantEntryInputs implements TenantEntryInputs {
  constructor(
    private readonly base: TenantEntryInputs,
    private readonly handOver: DatabaseHandOver,
    private readonly random: () => string = systemRandom
  ) {}

  async secrets(request: StepRequest): Promise<{
    readonly template: string;
    readonly values: Readonly<Record<string, string>>;
  }> {
    const slot = slotOf(request);
    const { template, values: literals } = await this.base.secrets(request);
    const names = templateKeys(template);
    for (const name of Object.keys(literals)) {
      if (!names.includes(name)) {
        throw new PermanentStepError(
          'the secrets file gives a value for a key the template does not name'
        );
      }
      if (!LITERAL_KEYS.includes(name)) {
        throw new PermanentStepError(
          `the secrets file gives a value for ${name}, which the controller fills itself`
        );
      }
    }
    const values: Record<string, string> = {};
    for (const name of names) {
      if (name === DATABASE_PASSWORD_KEY) {
        const password = await this.handOver.read(slot);
        if (password === undefined) {
          throw new PermanentStepError(
            `no database credential is held for slot ${slot}; the create-database step has not completed`
          );
        }
        values[name] = password;
      } else if (LITERAL_KEYS.includes(name)) {
        const literal = literals[name];
        if (literal === undefined) {
          throw new PermanentStepError(
            `the secrets file has no value for ${name} for slot ${slot}`
          );
        }
        values[name] = literal;
      } else if (PLACEHOLDER_KEYS.includes(name)) {
        values[name] = `${PLACEHOLDER_PREFIX}${this.random()}`;
      } else {
        values[name] = this.random();
      }
    }
    return { template, values };
  }

  stack(request: StepRequest, claim: EntryClaim): Promise<StackParameters> {
    return this.base.stack(request, claim);
  }

  deployKey(request: StepRequest): Promise<string> {
    return this.base.deployKey(request);
  }

  async delivered(request: StepRequest): Promise<void> {
    await this.handOver.discard(slotOf(request));
    await this.base.delivered?.(request);
  }
}
