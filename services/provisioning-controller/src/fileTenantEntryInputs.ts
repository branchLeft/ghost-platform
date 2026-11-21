import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { PermanentStepError } from './errors.js';
import type { StepRequest } from './executePorts.js';
import type {
  EntryClaim,
  StackParameters,
  StackSize,
  TenantEntryInputs,
} from './tenantEntryHost.js';
import { TrustedFileError } from './trustedFile.js';

/**
 * The deployment adapter behind `TenantEntryInputs`: the secrets template and values, the stack
 * parameters and the deploy key's public half, each read from a file the controller host is given.
 * The paths come from the `sshEntry.inputs` configuration and have no default.
 *
 * - **Trusted files.** Each is opened without following a link, and refused unless it is a regular
 *   file, owned by root or by the user the controller runs as, writable by that owner alone
 *   (no group or other write), and not larger than `MAX_INPUT_BYTES`. The secrets file is also
 *   refused if anyone outside the owner and its group can read it.
 * - **Read when needed, kept never.** A file is read in full each time a verb needs it, so a
 *   change on the host is seen at the next step and no value stays in memory between calls.
 * - **No value in a message.** An error names the file's path, the slot and the field; never
 *   anything the file held, and not the parser's own message, which can quote it.
 *
 * Each file is one JSON object keyed by the slot name:
 *
 * - `secretsFile`: `{ "template": TEXT, "values": { SLOT: { NAME: VALUE } } }`
 * - `stackFile`: `{ SLOT: { "size", "mail", "environment" } }`
 * - `deployKeyFile`: `{ SLOT: PUBLIC_KEY }`
 */

export interface TenantEntryFiles {
  readonly secretsFile: string;
  readonly stackFile: string;
  readonly deployKeyFile: string;
}

export const MAX_INPUT_BYTES = 1_048_576;

const GROUP_OR_OTHER_WRITE = 0o022;
const OTHER_ACCESS = 0o007;
const SIZES: readonly string[] = ['small', 'standard', 'large'];

/** Who may own an input file: root, or the user the controller runs as. */
export function defaultOwners(): readonly number[] {
  const self = process.getuid?.();
  return self === undefined || self === 0 ? [0] : [0, self];
}

interface Rules {
  /** Mode bits that must all be clear. */
  readonly forbidden: number;
  readonly owners: readonly number[];
}

/** Reads one input file as JSON under the rules above; the content is never put in an error. */
async function readInputJson(path: string, rules: Rules): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new TrustedFileError(
      path,
      code === 'ELOOP' ? 'it is a symbolic link' : 'it cannot be opened'
    );
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new TrustedFileError(path, 'it is not a regular file');
    if (!rules.owners.includes(info.uid)) {
      throw new TrustedFileError(path, 'it belongs to a user that may not own it');
    }
    if ((info.mode & rules.forbidden) !== 0) {
      throw new TrustedFileError(path, 'its mode lets other users read or write it');
    }
    if (info.size > MAX_INPUT_BYTES) throw new TrustedFileError(path, 'it is too large');
    const text = await file.readFile('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TrustedFileError(path, 'it is not JSON');
    }
  } finally {
    await file.close();
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function slotOf(request: StepRequest): string {
  const slot = request.inputs['slot'];
  if (typeof slot !== 'string' || slot === '') {
    throw new PermanentStepError(`step ${request.id} has no slot to act on`);
  }
  return slot;
}

function entryFor(path: string, doc: unknown, slot: string, where: string): unknown {
  if (!isRecord(doc)) throw new TrustedFileError(path, 'it is not a JSON object');
  const container = where === '' ? doc : doc[where];
  if (!isRecord(container)) throw new TrustedFileError(path, `it has no "${where}" object`);
  if (!Object.hasOwn(container, slot)) {
    throw new PermanentStepError(`${path} has no entry for slot ${slot}`);
  }
  return container[slot];
}

export class FileTenantEntryInputs implements TenantEntryInputs {
  constructor(
    private readonly files: TenantEntryFiles,
    private readonly owners: readonly number[] = defaultOwners()
  ) {}

  async secrets(
    request: StepRequest
  ): Promise<{ readonly template: string; readonly values: Readonly<Record<string, string>> }> {
    const slot = slotOf(request);
    const path = this.files.secretsFile;
    const doc = await readInputJson(path, {
      forbidden: GROUP_OR_OTHER_WRITE | OTHER_ACCESS,
      owners: this.owners,
    });
    if (!isRecord(doc) || typeof doc['template'] !== 'string' || doc['template'] === '') {
      throw new TrustedFileError(path, 'it has no "template" text');
    }
    const raw = entryFor(path, doc, slot, 'values');
    if (!isRecord(raw))
      throw new TrustedFileError(path, `the values for slot ${slot} are not an object`);
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value !== 'string') {
        throw new TrustedFileError(path, `a value for slot ${slot} is not text`);
      }
      values[name] = value;
    }
    return { template: doc['template'], values };
  }

  async stack(request: StepRequest, _claim: EntryClaim): Promise<StackParameters> {
    const slot = slotOf(request);
    const path = this.files.stackFile;
    const doc = await readInputJson(path, { forbidden: GROUP_OR_OTHER_WRITE, owners: this.owners });
    const raw = entryFor(path, doc, slot, '');
    const problem = (field: string): TrustedFileError =>
      new TrustedFileError(path, `the stack for slot ${slot} has a bad ${field}`);
    if (!isRecord(raw)) throw problem('shape');
    const extra = Object.keys(raw).filter((k) => !['size', 'mail', 'environment'].includes(k));
    if (extra.length > 0) throw problem(`key (${extra.join(', ')})`);
    const { size, mail, environment } = raw;
    if (typeof size !== 'string' || !SIZES.includes(size)) throw problem('size');
    if (typeof mail !== 'boolean') throw problem('mail');
    if (!isRecord(environment)) throw problem('environment');
    for (const value of Object.values(environment)) {
      const reference =
        isRecord(value) && Object.keys(value).length === 1 && typeof value['secret'] === 'string';
      const literal = ['string', 'number', 'boolean'].includes(typeof value);
      if (!reference && !literal) throw problem('environment value');
    }
    return { size: size as StackSize, mail, environment } as StackParameters;
  }

  async deployKey(request: StepRequest): Promise<string> {
    const slot = slotOf(request);
    const path = this.files.deployKeyFile;
    const doc = await readInputJson(path, { forbidden: GROUP_OR_OTHER_WRITE, owners: this.owners });
    const key = entryFor(path, doc, slot, '');
    if (typeof key !== 'string' || key === '') {
      throw new TrustedFileError(path, `the deploy key for slot ${slot} is not text`);
    }
    return key;
  }
}
