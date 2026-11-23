import { PermanentStepError } from './errors.js';
import type { HostEntryPoint, StepRequest } from './executePorts.js';
import type { StepId } from './plan.js';

/**
 * The adapter for the app host's tenant entry point, the program the host
 * runs for the controller's key (the `tenant_entry` role in
 * branchLeft/shared-infra holds its verbs, order and exit codes). It serves
 * three plan steps and passes every other step to the entry point the
 * deployment configured for it:
 *
 * - `render-host-secrets`: `claim`, then `secrets`.
 * - `render-compose-file`: `stack`, with parameters only. The host builds the
 *   compose file itself from its own template, the claim's uid and ports and
 *   these parameters, judges it, and writes it. The controller never sends
 *   compose text and never an image pin: the first pin is written by
 *   `branchleft-deploy`, after it has verified the image's attestation, in the
 *   plan's `first-deploy` step.
 * - `create-app-host-slot`: `enable`, then `key`.
 *
 * Every step first asks the host how far the slug has got (`status`) and does
 * only what is left, so a step that is run again after the host took effect
 * (the executor's resume, or a retry after a lost reply) sends nothing twice.
 * The host's order is enforced by the host; this adapter also refuses to enable
 * a unit whose stack is not in place, so the plan's order is kept even against
 * a host that would allow it.
 */

/** The verbs the host program accepts. */
export const ENTRY_VERBS = [
  'status',
  'claim',
  'secrets',
  'stack',
  'enable',
  'key',
  'owner',
] as const;
export type EntryVerb = (typeof ENTRY_VERBS)[number];

/** The host program's exit codes: done, refused (a word on stderr), usage, busy, a step failed. */
export const ENTRY_EXIT = { done: 0, refused: 1, usage: 2, busy: 3, failed: 4 } as const;

/** What one request to the host returned. */
export interface EntryReply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * One request to the host program: `VERB SLUG` and, for a verb that needs more,
 * one JSON object on standard input. In production this is the controller's SSH
 * key running the host's forced command; here it is a port so no key or address
 * is the controller's code. A reply that cannot be had throws.
 */
export interface EntryTransport {
  send(
    verb: EntryVerb,
    slug: string,
    payload?: Readonly<Record<string, unknown>>
  ): Promise<EntryReply>;
}

/** The uid and ports the host's `claim` gave a slug; the host's own numbers, never the register's. */
export interface EntryClaim {
  readonly uid: number;
  readonly portA: number;
  readonly portB: number;
  readonly portHealth: number;
}

/** The three sizes the host maps to its own cpu, process and file caps. */
export type StackSize = 'small' | 'standard' | 'large';

/** A literal (no `$`), or a reference to a key of the tenant's secrets file. Never a secret value. */
export type EnvironmentValue = string | number | boolean | { readonly secret: string };

/**
 * What a `stack` request may carry, and all of it: the host refuses any other key, a compose
 * text and an image pin included. The adapter sends exactly these three fields.
 */
export interface StackParameters {
  readonly size: StackSize;
  readonly mail: boolean;
  readonly environment: Readonly<Record<string, EnvironmentValue>>;
}

/**
 * What the verbs need that the plan's inputs, which carry names and register
 * values and never a secret, do not: the template and values of the tenant's
 * secrets file, the stack's parameters, and the deploy key's public half. A
 * deployment supplies them; each is read only when the verb that needs it is
 * about to be sent, and none is kept. `stack` is given the host's claim, so
 * anything that depends on the uid or a port uses the host's numbers.
 */
export interface TenantEntryInputs {
  secrets(request: StepRequest): Promise<{
    readonly template: string;
    readonly values: Readonly<Record<string, string>>;
  }>;
  stack(request: StepRequest, claim: EntryClaim): Promise<StackParameters>;
  deployKey(request: StepRequest): Promise<string>;
  /**
   * Called once the host has the tenant's secrets file in place (just written, or found already
   * there), so a deployment can drop any copy it held to get the values there.
   */
  delivered?(request: StepRequest): Promise<void>;
}

export interface TenantEntryHostOptions {
  readonly transport: EntryTransport;
  readonly inputs: TenantEntryInputs;
  /** Serves every step this adapter does not. */
  readonly fallback: HostEntryPoint;
}

/** How far the host says a slug has got. */
interface SlugStatus {
  readonly claimed: boolean;
  /** The claim's numbers; present exactly when `claimed`. */
  readonly claim: EntryClaim | null;
  readonly volumes: boolean;
  readonly secrets: boolean;
  readonly stack: boolean;
  readonly enabled: boolean;
  readonly slot: boolean;
}

const SERVED: ReadonlySet<StepId> = new Set<StepId>([
  'render-host-secrets',
  'render-compose-file',
  'create-app-host-slot',
]);

const DETAIL_LIMIT = 150;
const WORD = /^[a-z][a-z-]{0,40}$/;

const yes = (lines: ReadonlyMap<string, string>, key: string): boolean => lines.get(key) === 'yes';

function claimOf(lines: ReadonlyMap<string, string>): EntryClaim {
  const number = (key: string): number => {
    const text = lines.get(key);
    if (text === undefined || !/^[0-9]{1,6}$/.test(text)) {
      throw new Error(`the host entry point's status carries no readable ${key}`);
    }
    return Number(text);
  };
  return {
    uid: number('uid'),
    portA: number('port_a'),
    portB: number('port_b'),
    portHealth: number('port_health'),
  };
}

function parseStatus(reply: EntryReply): SlugStatus {
  const lines = new Map<string, string>();
  for (const line of reply.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) lines.set(line.slice(0, at), line.slice(at + 1));
  }
  if (!lines.has('claimed-here')) {
    throw new Error('the host entry point answered status with nothing the adapter can read');
  }
  const claimed = yes(lines, 'claimed-here');
  return {
    claimed,
    claim: claimed ? claimOf(lines) : null,
    volumes: yes(lines, 'volumes'),
    secrets: yes(lines, 'secrets'),
    stack: yes(lines, 'stack'),
    enabled: yes(lines, 'enabled'),
    slot: yes(lines, 'slot'),
  };
}

/** A line of the host's message with no control characters and none of the values the request carried. */
function clean(text: string, withheld: readonly string[]): string {
  let out = text.replace(/\p{Cc}+/gu, ' ');
  for (const value of withheld) {
    if (value.length > 0) out = out.split(value).join('[withheld]');
  }
  return out.slice(0, DETAIL_LIMIT);
}

export class TenantEntryHost implements HostEntryPoint {
  constructor(private readonly options: TenantEntryHostOptions) {}

  async run(request: StepRequest): Promise<void> {
    if (!SERVED.has(request.id)) return this.options.fallback.run(request);
    const slug = request.inputs['slot'];
    if (typeof slug !== 'string' || slug === '') {
      throw new PermanentStepError(`step ${request.id} has no slot to act on`);
    }
    switch (request.id) {
      case 'render-host-secrets':
        return this.renderHostSecrets(request, slug);
      case 'render-compose-file':
        return this.renderComposeFile(request, slug);
      default:
        return this.createAppHostSlot(request, slug);
    }
  }

  private async renderHostSecrets(request: StepRequest, slug: string): Promise<void> {
    let status = await this.status(slug);
    if (!status.claimed) {
      await this.call('claim', slug);
      status = await this.status(slug);
    }
    if (!status.claimed || !status.volumes) {
      throw new PermanentStepError(
        `the host's claim for ${request.id} is not whole: its volumes are missing`
      );
    }
    if (status.secrets) {
      await this.options.inputs.delivered?.(request);
      return;
    }
    const { template, values } = await this.options.inputs.secrets(request);
    await this.call('secrets', slug, { template, values }, Object.values(values));
    await this.options.inputs.delivered?.(request);
  }

  private async renderComposeFile(request: StepRequest, slug: string): Promise<void> {
    const status = await this.status(slug);
    if (!status.claimed || status.claim === null || !status.secrets) {
      throw new PermanentStepError('the secrets step is not done on the host; no stack is sent');
    }
    if (status.stack) return;
    const parameters = await this.options.inputs.stack(request, status.claim);
    // Exactly the three fields, picked here: whatever else a provider returned is not sent.
    await this.call('stack', slug, {
      size: parameters.size,
      mail: parameters.mail,
      environment: parameters.environment,
    });
  }

  private async createAppHostSlot(request: StepRequest, slug: string): Promise<void> {
    const status = await this.status(slug);
    if (!status.claimed || !status.secrets || !status.stack) {
      throw new PermanentStepError(
        'the stack is not in place on the host; the unit is not enabled'
      );
    }
    if (!status.enabled) await this.call('enable', slug);
    if (status.slot) return;
    const publicKey = await this.options.inputs.deployKey(request);
    await this.call('key', slug, { public_key: publicKey }, [publicKey]);
  }

  /**
   * The uid and ports the host gave a slug, read from its status, or null for a slug it never
   * claimed. For a deployment's other steps (the edge's port, for one), which must use the host's
   * numbers and not the register's.
   */
  async claimOf(slug: string): Promise<EntryClaim | null> {
    return (await this.status(slug)).claim;
  }

  private async status(slug: string): Promise<SlugStatus> {
    return parseStatus(await this.call('status', slug));
  }

  /** Sends one request and returns the reply, or throws what the executor needs to retry or stop. */
  private async call(
    verb: EntryVerb,
    slug: string,
    payload?: Readonly<Record<string, unknown>>,
    withheld: readonly string[] = []
  ): Promise<EntryReply> {
    const reply = await this.options.transport.send(verb, slug, payload);
    if (reply.code === ENTRY_EXIT.done) return reply;
    const [first = '', ...rest] = reply.stderr.split('\n').filter((l) => l !== '');
    if (reply.code === ENTRY_EXIT.refused) {
      const word = first.replace(/^refused: /, '');
      const named = WORD.test(word) ? word : 'unreadable';
      const detail = clean(rest.join('; '), withheld);
      throw new PermanentStepError(
        `tenant entry refused ${verb} with ${named}${detail === '' ? '' : ` (${detail})`}`
      );
    }
    if (reply.code === ENTRY_EXIT.usage) {
      throw new PermanentStepError(`tenant entry did not understand ${verb}`);
    }
    // Busy, a step that failed on the host, or a code this adapter does not know: try again.
    const what = reply.code === ENTRY_EXIT.busy ? 'is busy' : `failed (${clean(first, withheld)})`;
    throw new Error(`tenant entry ${verb} ${what}`);
  }
}
