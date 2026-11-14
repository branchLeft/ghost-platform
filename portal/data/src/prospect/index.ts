import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { bind, connect, enterRole, type PortalDb, type Tx } from '../db.js';
import { UNIQUE_VIOLATION, readDatabaseError } from '../databaseError.js';
import {
  DemoRequestExistsError,
  DemoRequestIdTakenError,
  deriveOwnRequestView,
  parseDemoRequest,
  parseVerifiedAddress,
  type DemoRequestInput,
  type OwnRequestView,
} from '../demoRequest.js';
import { demoRequest } from '../schema.js';

export {
  DemoRequestExistsError,
  DemoRequestIdTakenError,
  InvalidDemoRequestError,
  type DemoRequestInput,
  type OwnRequestView,
} from '../demoRequest.js';

/**
 * The front door's path: a separate entry point on purpose, used by the
 * internet-facing prospect application alone. The pool it takes is connected
 * as a login that is a member of `portal_prospect` alone, a role that can
 * insert a request, can read the one row whose address the transaction has
 * bound, and can neither update nor delete anything (see the README). It holds
 * no tenant, no register and no signing key. The time of a request is the
 * database's clock and is never taken from a caller.
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

  /**
   * The request recorded for the signed-in address, or undefined when there is
   * none. The address is bound to the transaction and the table's row policy
   * does the filtering: no `WHERE` here chooses the row, so a statement that
   * forgot one still sees this address's row and no other.
   *
   * @throws InvalidDemoRequestError when the address is not one the table could hold
   */
  async ownRequest(verifiedAddress: string): Promise<OwnRequestView | undefined> {
    const address = parseVerifiedAddress(verifiedAddress);
    return this.run(async (tx) => {
      await bind(tx, 'portal.prospect_address', address);
      const [found] = await tx
        .select({
          demoId: demoRequest.demoId,
          publicationName: demoRequest.publicationName,
          submittedAt: demoRequest.submittedAt,
        })
        .from(demoRequest);
      return found === undefined ? undefined : deriveOwnRequestView(found);
    });
  }
}
