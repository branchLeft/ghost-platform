import type { OwnerDb } from 'ghost-platform-portal-data/owner';
import { createOwnerConsole } from '../src/console/app.js';
import { Browser, serve, type Running } from './browser.js';
import {
  CLIENT_CONSOLE,
  FakeIssuer,
  ISSUER,
  jwks,
  mint,
  NOW,
  OWNER_ORG,
  PROJECT_ID,
} from './idp.js';

export type PublishInput = Parameters<OwnerDb['publishDocument']>[0];

export interface DocumentsRig {
  readonly console_: Running;
  readonly issuer: FakeIssuer;
  /** Every publication the console asked the data layer for. */
  readonly published: PublishInput[];
  /** The lines the console wrote through `onError`. */
  readonly errors: string[];
  ownerBrowser(): Promise<Browser>;
  /** A POST with this console's origin, as a form submit from its own page. */
  post(
    browser: Browser,
    path: string,
    fields: Record<string, string>
  ): ReturnType<Browser['request']>;
  close(): Promise<void>;
}

/** The fields a form for a plain document carries; test text only. */
export const TERMS_FORM: Readonly<Record<string, string>> = {
  kind: 'terms',
  title: 'TEST_TERMS_TITLE',
  effective_date: '2026-12-01',
  body: 'TEST_TERMS_BODY',
};

/**
 * An owner console whose data layer is `db`, or, left out, one that only
 * records the publications it is asked for. Nothing is stored.
 */
export async function startDocumentsRig(
  options: {
    readonly build?: typeof createOwnerConsole;
    readonly db?: Pick<OwnerDb, 'publishDocument'>;
  } = {}
): Promise<DocumentsRig> {
  const published: PublishInput[] = [];
  const errors: string[] = [];
  const issuer = new FakeIssuer();
  const db =
    options.db ??
    ({
      publishDocument: (input: PublishInput) => {
        published.push(input);
        return Promise.resolve({ ...input, version: 1 });
      },
    } as Pick<OwnerDb, 'publishDocument'>);
  const build = options.build ?? createOwnerConsole;
  const console_ = await serve((origin) =>
    build({
      issuer: ISSUER,
      clientId: CLIENT_CONSOLE,
      projectId: PROJECT_ID,
      publicOrigin: origin,
      ownerOrgId: OWNER_ORG,
      db: {
        listHealth: () => Promise.resolve([]),
        listSupportRequests: () => Promise.resolve([]),
        countProfessionalEnquiries: () => Promise.resolve(0),
        listErasureRequests: () => Promise.resolve([]),
        publishDocument: db.publishDocument.bind(db),
      } as unknown as OwnerDb,
      secureCookies: false,
      clock: () => NOW,
      fetch: issuer.fetch,
      fetchKeys: async () => jwks,
      onError: (line) => errors.push(line),
    })
  );
  return {
    console_,
    issuer,
    published,
    errors,
    async ownerBrowser() {
      const browser = new Browser(console_.origin);
      const token = mint({ org: OWNER_ORG, client: CLIENT_CONSOLE, role: 'owner' });
      await browser.finish(issuer.issue(token));
      return browser;
    },
    post: (browser, path, fields) =>
      browser.request(path, {
        method: 'POST',
        headers: {
          origin: console_.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(fields).toString(),
      }),
    close: () => console_.close(),
  };
}
