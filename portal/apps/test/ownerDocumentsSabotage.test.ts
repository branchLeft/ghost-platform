import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { OwnerDb } from 'ghost-platform-portal-data/owner';
import { createOwnerConsole } from '../src/console/app.js';
import { createDocumentsScreen } from '../src/console/documentsScreen.js';
import { Browser } from './browser.js';
import { CLIENT_CONSOLE, mint, OWNER_ORG } from './idp.js';
import { startDocumentsRig, TERMS_FORM, type DocumentsRig } from './ownerDocumentsRig.js';
import { TENANT_ORG } from './ownerRequestsRig.js';
import { CONSOLE, clearMutants, DOCUMENTS, importSabotaged } from './sourceSabotage.js';

interface ConsoleModule {
  readonly createOwnerConsole: typeof createOwnerConsole;
}
interface DocumentsModule {
  readonly createDocumentsScreen: typeof createDocumentsScreen;
}

let rig: DocumentsRig | undefined;
beforeAll(clearMutants);
afterAll(clearMutants);
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('sabotage: only the owner role may publish', () => {
  /** A tenant-role holder in the owner's own organisation tries to publish. */
  async function tryPublishing(build: typeof createOwnerConsole): Promise<{
    readonly signIn: number;
    readonly published: number;
  }> {
    rig = await startDocumentsRig({ build });
    const browser = new Browser(rig.console_.origin);
    const token = mint({ org: OWNER_ORG, client: CLIENT_CONSOLE, role: 'tenant-admin' });
    const signIn = (await browser.finish(rig.issuer.issue(token))).status;
    await rig.post(browser, '/documents/publish', TERMS_FORM);
    return { signIn, published: rig.published.length };
  }

  it('RED: a console that does not require the owner role lets a tenant-role session publish, GREEN: the real one refuses it', async () => {
    const broken = await importSabotaged<ConsoleModule>(
      'documents-console-no-owner-role',
      'requiredRole: ROLE_OWNER,',
      "requiredRole: 'tenant-admin',",
      CONSOLE
    );
    expect(await tryPublishing(broken.createOwnerConsole)).toEqual({ signIn: 302, published: 1 });
    await rig?.close();
    rig = undefined;

    expect(await tryPublishing(createOwnerConsole)).toEqual({ signIn: 403, published: 0 });
  });
});

describe('sabotage: the Publish action checks the organisation itself', () => {
  const reach = async (
    make: typeof createDocumentsScreen
  ): Promise<{ readonly outcome: string; readonly published: number }> => {
    let published = 0;
    const db = {
      publishDocument: () => {
        published += 1;
        return Promise.resolve({});
      },
    } as unknown as Pick<OwnerDb, 'publishDocument'>;
    const action = make(db, OWNER_ORG).actions['/documents/publish'];
    let outcome: string;
    try {
      outcome =
        (await action?.(
          true,
          { subject: 'user-1', orgId: TENANT_ORG },
          new URLSearchParams(TERMS_FORM)
        )) ?? 'none';
    } catch (error) {
      outcome = error instanceof Error ? error.name : 'threw';
    }
    return { outcome, published };
  };

  it('RED: without the check a tenant organisation session publishes, GREEN: the real action throws and publishes nothing', async () => {
    const broken = await importSabotaged<DocumentsModule>(
      'documents-no-owner-check',
      "if (identity.orgId !== ownerOrgId) throw new DocumentPublishError('not-owner');",
      '',
      DOCUMENTS
    );
    expect(await reach(broken.createDocumentsScreen)).toEqual({
      outcome: '/documents/published',
      published: 1,
    });
    expect(await reach(createDocumentsScreen)).toEqual({
      outcome: 'DocumentPublishError',
      published: 0,
    });
  });
});
