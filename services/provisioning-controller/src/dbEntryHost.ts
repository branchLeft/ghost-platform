import { DB_PASSWORD_SHAPE, type DatabaseHandOver } from './dbHandOver.js';
import { PermanentStepError } from './errors.js';
import type { HostEntryPoint, StepRequest } from './executePorts.js';
import type { EntryReply } from './tenantEntryHost.js';

/**
 * The adapter for the tenant database host's entry point (`db-host`): the one program db-t1 runs for
 * the controller's key (the `db_t1_tenant_entry` role in branchLeft/shared-infra). It serves the
 * plan's `create-database` step and nothing else. The program accepts one request, `create-tenant-db
 * NAME`, and for a name that is free it makes the database and its account and prints three lines
 * once: `database=`, `user=` and `password=`.
 *
 * The password has one place to go: the hand-over port, from which `render-host-secrets` takes it to
 * the app host. It is never returned, never put in an error, and never recorded. A step that is run
 * again after the database was made finds the held copy and sends nothing, because db-t1 would
 * refuse a second create (`exists`) and never print the password again.
 */

/** The db-t1 program's exit codes: created, a refused request, the name exists, busy, the database failed. */
export const DB_EXIT = { created: 0, refused: 2, exists: 3, busy: 4, failed: 5 } as const;

/** One request to db-t1's program. In production the controller's key running its forced command. */
export interface DbEntryTransport {
  send(verb: 'create-tenant-db', name: string): Promise<EntryReply>;
}

export interface DbEntryHostOptions {
  readonly transport: DbEntryTransport;
  readonly handOver: DatabaseHandOver;
}

/** The tenant-name rule the program applies (its own copy of ghost-platform's naming rule). */
const TENANT_NAME = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const MAX_TENANT_NAME_LENGTH = 26;
/** What the program names the database and the account: `ghost_` and the name with hyphens as underscores. */
const databaseNameOf = (name: string): string => `ghost_${name.replace(/-/g, '_')}`;

const REASON = /reason=([a-z][a-z-]{0,40})(?![a-z-])/;
const reasonOf = (stderr: string): string => REASON.exec(stderr)?.[1] ?? 'unreadable';

const UNREADABLE =
  "the db host's reply is not the three lines the controller reads; the database may exist with no copy of its credential held";

/** Reads the three lines. Throws without quoting a line: one of them is the password. */
function passwordOf(stdout: string, name: string): string {
  const fields = new Map<string, string>();
  const lines = stdout.split('\n').filter((l) => l !== '');
  for (const line of lines) {
    const at = line.indexOf('=');
    if (at <= 0) throw new PermanentStepError(UNREADABLE);
    const key = line.slice(0, at);
    if (fields.has(key)) throw new PermanentStepError(UNREADABLE);
    fields.set(key, line.slice(at + 1));
  }
  const database = databaseNameOf(name);
  const password = fields.get('password');
  if (
    lines.length !== 3 ||
    fields.get('database') !== database ||
    !(fields.get('user') ?? '').startsWith(`${database}@`) ||
    password === undefined ||
    !DB_PASSWORD_SHAPE.test(password)
  ) {
    throw new PermanentStepError(UNREADABLE);
  }
  return password;
}

export class DbEntryHost implements HostEntryPoint {
  constructor(private readonly options: DbEntryHostOptions) {}

  async run(request: StepRequest): Promise<void> {
    if (request.id !== 'create-database') {
      throw new PermanentStepError(`the db host does not serve step ${request.id}`);
    }
    const name = request.inputs['slot'];
    if (
      typeof name !== 'string' ||
      !TENANT_NAME.test(name) ||
      name.length > MAX_TENANT_NAME_LENGTH
    ) {
      throw new PermanentStepError(`step ${request.id} has no slot the db host would accept`);
    }
    // Made already, with its credential held: a resume, or a retry after the record was lost.
    if (await this.options.handOver.has(name)) return;

    const reply = await this.options.transport.send('create-tenant-db', name);
    if (reply.code === DB_EXIT.created) {
      const password = passwordOf(reply.stdout, name);
      try {
        await this.options.handOver.store(name, password);
      } catch {
        throw new PermanentStepError(
          `the database for slot ${name} was made on the db host but its credential could not be held; ` +
            'the database and account must be removed there before the step is run again'
        );
      }
      return;
    }
    const reason = reasonOf(reply.stderr);
    if (reply.code === DB_EXIT.exists) {
      throw new PermanentStepError(
        `the db host refused create-tenant-db with ${reason}, and no copy of the credential is held here; ` +
          'the database and account for this slot must be removed there before the step is run again'
      );
    }
    if (reply.code === DB_EXIT.refused) {
      throw new PermanentStepError(`the db host refused create-tenant-db with ${reason}`);
    }
    // Busy, the database could not be reached or a statement failed, or a code not known: try again.
    // A retry after a half-made tenant meets `exists`, which is permanent and says so.
    const what = reply.code === DB_EXIT.busy ? 'is busy' : `failed (${reason})`;
    throw new Error(`db host create-tenant-db ${what}`);
  }
}
