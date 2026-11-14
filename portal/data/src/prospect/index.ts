import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { connect, enterRole, type PortalDb, type Tx } from '../db.js';
import { UNIQUE_VIOLATION, readDatabaseError } from '../databaseError.js';
import {
  DemoRequestExistsError,
  DemoRequestIdTakenError,
  parseDemoRequest,
  type DemoRequestInput,
} from '../demoRequest.js';
import { demoRequest } from '../schema.js';

export {
  DemoRequestExistsError,
  DemoRequestIdTakenError,
  InvalidDemoRequestError,
  type DemoRequestInput,
} from '../demoRequest.js';

/**
 * The front door's only write path: a separate entry point on purpose, used by
 * the internet-facing prospect application alone. The pool it takes is
 * connected as a login that is a member of `portal_prospect` alone, a role
 * that can insert a request and can neither read, update nor delete anything
 * (see the README). It holds no tenant, no register and no signing key. The
 * time of a request is the database's clock and is never taken from a caller.
 */
export class ProspectDb {
  private readonly db: PortalDb;

  /** `newId` is the seam for a test; by default a demo id comes from the random source. */
  constructor(
    pool: Pool,
    private readonly newId: () => string = randomUUID
  ) {
    this.db = connect(pool);
  }

  /** One unit of work as the `portal_prospect` role. */
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await enterRole(tx, 'portal_prospect');
      return work(tx);
    });
  }

  /**
   * Records a prospect's request and returns the opaque id the demo will run
   * under. The table refuses a second request for the same verified address
   * whichever process sends it.
   *
   * @throws InvalidDemoRequestError
   * @throws DemoRequestExistsError
   * @throws DemoRequestIdTakenError
   */
  async submit(input: DemoRequestInput): Promise<{ demoId: string }> {
    const row = parseDemoRequest(input);
    const demoId = this.newId();
    return this.run(async (tx) => {
      try {
        await tx.insert(demoRequest).values({ ...row, demoId });
      } catch (error) {
        const found = readDatabaseError(error);
        if (found?.code === UNIQUE_VIOLATION) {
          if (found.constraint === 'demo_request_pkey') throw new DemoRequestIdTakenError();
          throw new DemoRequestExistsError();
        }
        throw error;
      }
      return { demoId };
    });
  }
}
