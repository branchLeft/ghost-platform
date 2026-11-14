import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './browser.js';
import { CLIENT_CONSOLE, mint, OWNER_ORG } from './idp.js';
import {
  OWNER_CREDENTIAL,
  requestId,
  startRig,
  TENANT_ORG,
  TENANT_TWO,
  type Rig,
} from './ownerRequestsRig.js';
import { CONSOLE, clearMutants, importSabotaged, REQUESTS } from './sourceSabotage.js';
import { createOwnerConsole } from '../src/console/app.js';
import { createRequestsScreen } from '../src/console/requestsScreen.js';

interface ConsoleModule {
  readonly createOwnerConsole: typeof createOwnerConsole;
}
interface RequestsModule {
  readonly createRequestsScreen: typeof createRequestsScreen;
}

let rig: Rig | undefined;
beforeAll(clearMutants);
afterAll(clearMutants);
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

/** A tenant-role holder in the owner's own organisation tries to approve a request. */
async function tryApproving(build: typeof createOwnerConsole): Promise<{
  readonly signIn: number;
  readonly approved: number;
}> {
  rig = await startRig({ build });
  rig.mock.store.createRequest(TENANT_TWO, 'essentials');
  const browser = new Browser(rig.console_.origin);
  const token = mint({ org: OWNER_ORG, client: CLIENT_CONSOLE, role: 'tenant-admin' });
  const signIn = (await browser.finish(rig.issuer.issue(token))).status;
  await rig.post(browser, '/requests/approve', { request_id: requestId(1) });
  return { signIn, approved: rig.mock.store.listRequests('approved').length };
}

describe('sabotage: only the owner role may approve', () => {
  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(
      importSabotaged('noop', 'text that is not in the module', 'x', CONSOLE)
    ).rejects.toThrow('exactly once');
  });

  it('RED: a console that does not require the owner role lets a tenant-role session approve, GREEN: the real one refuses it', async () => {
    const broken = await importSabotaged<ConsoleModule>(
      'console-no-owner-role',
      'requiredRole: ROLE_OWNER,',
      "requiredRole: 'tenant-admin',",
      CONSOLE
    );
    const red = await tryApproving(broken.createOwnerConsole);
    expect(red).toEqual({ signIn: 302, approved: 1 });
    await rig?.close();
    rig = undefined;

    const green = await tryApproving(createOwnerConsole);
    expect(green).toEqual({ signIn: 403, approved: 0 });
  });
});

describe('sabotage: the Approve action checks the organisation itself', () => {
  const reach = async (
    make: typeof createRequestsScreen
  ): Promise<{
    readonly outcome: string;
    readonly approved: number;
  }> => {
    rig = await startRig();
    rig.mock.store.createRequest(TENANT_TWO, 'essentials');
    const screen = make({ baseUrl: rig.api.baseUrl, ownerCredential: OWNER_CREDENTIAL }, OWNER_ORG);
    const action = screen.actions['/requests/approve'];
    const form = new URLSearchParams({ request_id: requestId(1) });
    let outcome: string;
    try {
      outcome = (await action?.(true, { subject: 'user-1', orgId: TENANT_ORG }, form)) ?? 'none';
    } catch (error) {
      outcome = error instanceof Error ? error.name : 'threw';
    }
    return { outcome, approved: rig.mock.store.listRequests('approved').length };
  };

  it('RED: without the check a tenant organisation session approves, GREEN: the real action throws and approves nothing', async () => {
    const broken = await importSabotaged<RequestsModule>(
      'requests-no-owner-check',
      "if (identity.orgId !== ownerOrgId) throw new ProvisioningError('not-owner');",
      '',
      REQUESTS
    );
    expect(await reach(broken.createRequestsScreen)).toEqual({ outcome: '/requests', approved: 1 });
    await rig?.close();
    rig = undefined;

    expect(await reach(createRequestsScreen)).toEqual({
      outcome: 'ProvisioningError',
      approved: 0,
    });
  });
});
