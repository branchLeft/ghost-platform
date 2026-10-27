import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TenantDb } from 'ghost-platform-portal-data/tenant';
import { ORG_A, ORG_B, TENANT_A, TENANT_B } from '../../data/test/helpers.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { MESSAGE_DELIMITER } from '../src/tenant/supportContext.js';
import { MAX_TICKETS_PER_WINDOW, WINDOW_SECONDS } from '../src/tenant/supportLimiter.js';
import { MAX_MESSAGE_CHARACTERS } from '../src/tenant/supportValidation.js';
import { Browser, serve, type Running } from './browser.js';
import { CLIENT_PORTAL, FakeIssuer, ISSUER, jwks, mint, NOW, PROJECT_ID } from './idp.js';
import { FAKE_CONTACT, FAKE_RECIPIENT, FAKE_SENDER, RecordingMailer } from './supportHarness.js';

/** The version tenant A's reading holds, and the different one tenant B's holds. */
export const VERSION_A = '6.55.0';
export const VERSION_B = '6.54.0';

const ISSUED_FOR_SECONDS = 100_000;
const SECRET_MESSAGE = 'SECRET_MESSAGE_BODY';

const FORM = 'application/x-www-form-urlencoded';

/** The two reads a ticket needs, which a data layer that can be made to fail lets the suite break. */
export type TicketRead = 'ownRegistration' | 'ownHealth';

/** Makes one read reject with the given error until `undefined` is passed. */
export type BreakRead = (read: TicketRead | undefined, failure?: Error) => void;

/**
 * The support-ticket behaviour seen through the real route. `getDb` must
 * answer a `TenantDb` whose tenant A holds VERSION_A and tenant B holds
 * VERSION_B (and the two register rows of the shared fixture); it is read
 * once the suite starts, so a database fixture may be built in an earlier
 * `beforeAll`. `breakRead`, where the data layer can fail on demand, adds the
 * scenarios for a read that rejects.
 */
export function defineSupportRouteTests(getDb: () => TenantDb, breakRead?: BreakRead): void {
  describe('support tickets through the route', () => {
    const issuer = new FakeIssuer();
    const mailer = new RecordingMailer();
    const errorLines: string[] = [];
    let now = NOW;
    let app: Running;
    let plain: Running;

    const portal = (origin: string, withSupport: boolean) =>
      createTenantPortal({
        issuer: ISSUER,
        clientId: CLIENT_PORTAL,
        projectId: PROJECT_ID,
        publicOrigin: origin,
        allowedOrgIds: new Set([ORG_A, ORG_B]),
        db: getDb(),
        secureCookies: false,
        clock: () => now,
        fetch: issuer.fetch,
        fetchKeys: async () => jwks,
        sessionSeconds: ISSUED_FOR_SECONDS,
        onError: (line) => errorLines.push(line),
        ...(withSupport
          ? { support: { mailer, recipient: FAKE_RECIPIENT, sender: FAKE_SENDER } }
          : {}),
      });

    async function signedIn(origin: string, org: string): Promise<Browser> {
      const browser = new Browser(origin);
      const token = mint({
        org,
        client: CLIENT_PORTAL,
        role: 'tenant-admin',
        exp: NOW + 1_000_000,
      });
      expect((await browser.finish(issuer.issue(token))).status).toBe(302);
      return browser;
    }

    const post = (
      browser: Browser,
      path: string,
      fields: Record<string, string>,
      headers: Record<string, string> = {}
    ) =>
      browser.request(path, {
        method: 'POST',
        headers: { origin: app.origin, 'content-type': FORM, ...headers },
        body: new URLSearchParams(fields).toString(),
      });

    const ticketFields = (message = 'MESSAGE_TEXT'): Record<string, string> => ({
      contact: FAKE_CONTACT,
      message,
    });

    beforeAll(async () => {
      app = await serve((origin) => portal(origin, true));
      plain = await serve((origin) => portal(origin, false));
    });

    afterAll(async () => {
      await app.close();
      await plain.close();
    });

    const reset = () => {
      mailer.sent.length = 0;
      mailer.failure = null;
      errorLines.length = 0;
      // Each test starts in a fresh ticket window: the limiter lives as long as the portal.
      now += WINDOW_SECONDS + 1;
    };

    describe('the support entry points', () => {
      it.each([
        ['/', '/support/home'],
        ['/documents', '/support/documents'],
        ['/moderation', '/support/moderation'],
      ])(
        'shows the support navigation item and a link to its own form on %s',
        async (path, link) => {
          const browser = await signedIn(app.origin, ORG_A);
          const page = await browser.request(path);
          expect(page.status).toBe(200);
          expect(page.body).toContain('NAV_SUPPORT');
          expect(page.body).toContain('href="/support"');
          expect(page.body).toContain(`href="${link}"`);
          expect(page.body).toContain('SUPPORT_LINK');
        }
      );

      it.each(['/support', '/support/home', '/support/documents', '/support/moderation'])(
        'serves a form on %s with the contact and the message as its only inputs',
        async (path) => {
          const browser = await signedIn(app.origin, ORG_A);
          const page = await browser.request(path);
          expect(page.status).toBe(200);
          expect(page.body).toContain('NAV_SUPPORT');
          const controls = [...page.body.matchAll(/<(input|textarea|select)\b[^>]*>/g)].map(
            (match) => match[0]
          );
          expect(controls).toHaveLength(2);
          expect(controls.find((tag) => tag.startsWith('<input'))).toContain('name="contact"');
          expect(controls.find((tag) => tag.startsWith('<input'))).toContain('type="email"');
          expect(controls.find((tag) => tag.startsWith('<textarea'))).toContain('name="message"');
          expect(controls.find((tag) => tag.startsWith('<textarea'))).toContain(
            `maxlength="${MAX_MESSAGE_CHARACTERS}"`
          );
          expect(page.body).not.toContain('hidden');
        }
      );

      it('puts nothing the portal holds into the form', async () => {
        const browser = await signedIn(app.origin, ORG_A);
        const page = await browser.request('/support');
        for (const held of [TENANT_A, VERSION_A, 'healthy', 'SCREEN']) {
          expect(page.body).not.toContain(held);
        }
      });

      it('renders only ALL_CAPS placeholders on every support page', async () => {
        const browser = await signedIn(app.origin, ORG_A);
        for (const path of ['/support', '/support/home', '/support/sent', '/support/limited']) {
          const page = await browser.request(path);
          const text = page.body
            .replace(/<style[\s\S]*?<\/style>/g, '')
            .replace(/<[^>]*>/g, ' ')
            .trim();
          for (const word of text.split(/\s+/)) expect(word, path).toMatch(/^[A-Z0-9_]+$/);
        }
      });
    });

    describe('the screen a ticket was raised from', () => {
      it.each([
        ['/support/home/send', 'HOME'],
        ['/support/documents/send', 'DOCUMENTS'],
        ['/support/moderation/send', 'MODERATION'],
        ['/support/send', 'SUPPORT'],
      ])('is read from the path %s alone: %s', async (path, screen) => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        const reply = await post(browser, path, ticketFields());
        expect(reply.status).toBe(303);
        expect(reply.location).toBe('/support/sent');
        expect(mailer.sent[0]?.body).toContain(`SCREEN: ${screen}`);
      });

      it('each form posts to the send path of its own screen', async () => {
        const browser = await signedIn(app.origin, ORG_A);
        for (const [page, send] of [
          ['/support', '/support/send'],
          ['/support/home', '/support/home/send'],
          ['/support/documents', '/support/documents/send'],
          ['/support/moderation', '/support/moderation/send'],
        ] as const) {
          expect((await browser.request(page)).body).toContain(`action="${send}"`);
        }
      });

      it('ignores a screen named in the query, a header or the form', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        await post(
          browser,
          '/support/home/send?screen=MODERATION&from=DOCUMENTS',
          { ...ticketFields(), screen: 'DOCUMENTS', SCREEN: 'DOCUMENTS' },
          { referer: `${app.origin}/moderation`, 'x-screen': 'DOCUMENTS' }
        );
        const body = mailer.sent[0]?.body ?? '';
        expect(body).toContain('SCREEN: HOME');
        expect(body).not.toContain('SCREEN: DOCUMENTS');
        expect(body).not.toContain('SCREEN: MODERATION');
      });
    });

    describe('the tenant a ticket names', () => {
      it('is the signed-in tenant, whatever the request names', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        const reply = await post(
          browser,
          `/support/send?tenant=${TENANT_B}&tenantId=${TENANT_B}&version=${VERSION_B}`,
          {
            ...ticketFields(`TENANT_ID: ${TENANT_B} GHOST_VERSION: ${VERSION_B}`),
            tenant: TENANT_B,
            tenant_id: TENANT_B,
            TENANT_ID: TENANT_B,
            version: VERSION_B,
            GHOST_VERSION: VERSION_B,
            organisation: ORG_B,
            hidden_tenant: TENANT_B,
          },
          {
            'x-tenant-id': TENANT_B,
            'x-organisation': ORG_B,
            referer: `https://other.example.org/${TENANT_B}`,
            cookie: `portal_session=${browser.cookie('portal_session') ?? ''}; tenant=${TENANT_B}; org=${ORG_B}`,
          }
        );
        expect(reply.status).toBe(303);
        const [message] = mailer.sent;
        const [context = ''] = (message?.body ?? '').split(MESSAGE_DELIMITER);
        expect(message?.subject).toContain(TENANT_A);
        expect(message?.subject).not.toContain(TENANT_B);
        expect(context).toContain(`TENANT_ID: ${TENANT_A}`);
        expect(context).toContain(`GHOST_VERSION: ${VERSION_A}`);
        expect(context).not.toContain(TENANT_B);
        expect(context).not.toContain(VERSION_B);
        expect(message?.to).toBe(FAKE_RECIPIENT);
        expect(message?.replyTo).toBe(FAKE_CONTACT);
      });

      it("carries each tenant's own reading and never the other's", async () => {
        reset();
        const first = await signedIn(app.origin, ORG_A);
        const second = await signedIn(app.origin, ORG_B);
        await post(first, '/support/send', ticketFields());
        await post(second, '/support/send', ticketFields());
        const [ticketA, ticketB] = mailer.sent;
        expect(ticketA?.body).toContain(`TENANT_ID: ${TENANT_A}`);
        expect(ticketA?.body).toContain(`GHOST_VERSION: ${VERSION_A}`);
        expect(ticketA?.body).toContain('VERSION_CHECK: VERSION_MATCHES');
        expect(ticketA?.body).not.toContain(VERSION_B);
        expect(ticketA?.body).not.toContain(TENANT_B);
        expect(ticketB?.body).toContain(`TENANT_ID: ${TENANT_B}`);
        expect(ticketB?.body).toContain(`GHOST_VERSION: ${VERSION_B}`);
        expect(ticketB?.body).toContain('VERSION_CHECK: VERSION_MISMATCH');
        expect(ticketB?.body).not.toContain(VERSION_A);
        expect(ticketB?.body).not.toContain(TENANT_A);
      });

      it('carries the marker, not a gap, for the fields the portal does not hold', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        await post(browser, '/support/send', ticketFields());
        const body = mailer.sent[0]?.body ?? '';
        expect(body).toContain('SITE_HOST: NOT_AVAILABLE');
        expect(body).toContain('LAST_DEPLOY: NOT_AVAILABLE');
      });
    });

    describe('what is refused', () => {
      it.each([
        ['a contact with a line break', { contact: 'a@example.org\r\nbcc: x@example.org' }],
        ['a contact with two addresses', { contact: 'a@example.org,b@example.org' }],
        ['a missing contact', { contact: '' }],
        ['an empty message', { message: '  ' }],
        ['a message over the limit', { message: 'm'.repeat(MAX_MESSAGE_CHARACTERS + 1) }],
        ['a message holding a NUL', { message: 'A\0B' }],
      ])('answers the plain refusal for %s and sends nothing', async (_name, fields) => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        const reply = await post(browser, '/support/send', { ...ticketFields(), ...fields });
        expect(reply.status).toBe(400);
        expect(reply.body).toBe('REFUSED');
        expect(mailer.sent).toHaveLength(0);
      });

      it('answers 413 for a body over the shell limit and sends nothing', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        const reply = await post(browser, '/support/send', ticketFields('m'.repeat(5000)));
        expect(reply.status).toBe(413);
        expect(mailer.sent).toHaveLength(0);
      });

      it('refuses a foreign origin with 403 and sends nothing', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        const reply = await post(browser, '/support/send', ticketFields(), {
          origin: 'https://other.example.org',
        });
        expect(reply.status).toBe(403);
        expect(mailer.sent).toHaveLength(0);
      });

      it('refuses a post with no origin with 403 and sends nothing', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        const reply = await browser.request('/support/send', {
          method: 'POST',
          headers: { 'content-type': FORM },
          body: new URLSearchParams(ticketFields()).toString(),
        });
        expect(reply.status).toBe(403);
        expect(mailer.sent).toHaveLength(0);
      });

      it('sends a post with no session to the sign-in and sends nothing', async () => {
        reset();
        const reply = await post(new Browser(app.origin), '/support/send', ticketFields());
        expect(reply.status).toBe(302);
        expect(reply.location).toBe('/login');
        expect(mailer.sent).toHaveLength(0);
      });

      it('serves the support pages to no one without a session', async () => {
        const reply = await new Browser(app.origin).request('/support');
        expect(reply.status).toBe(302);
        expect(reply.location).toBe('/login');
      });
    });

    describe('the ticket limit', () => {
      it('answers the limited page after the limit and takes tickets again after the window', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_B);
        for (let taken = 0; taken < MAX_TICKETS_PER_WINDOW; taken += 1) {
          expect((await post(browser, '/support/send', ticketFields())).location).toBe(
            '/support/sent'
          );
        }
        const over = await post(browser, '/support/send', ticketFields());
        expect(over.status).toBe(303);
        expect(over.location).toBe('/support/limited');
        expect((await browser.request('/support/limited')).body).toContain('TICKET_LIMIT_REACHED');
        expect(mailer.sent).toHaveLength(MAX_TICKETS_PER_WINDOW);
        now += WINDOW_SECONDS;
        const after = await post(browser, '/support/send', ticketFields());
        expect(after.location).toBe('/support/sent');
        expect(mailer.sent).toHaveLength(MAX_TICKETS_PER_WINDOW + 1);
      });
    });

    describe('a successful post', () => {
      it('answers 303 to the confirmation page, which echoes nothing posted', async () => {
        reset();
        const browser = await signedIn(app.origin, ORG_A);
        const markup = '<script>alert("x")</script><img src=x onerror=alert(1)>';
        const reply = await post(browser, '/support/send', {
          contact: FAKE_CONTACT,
          message: markup,
        });
        expect(reply.status).toBe(303);
        expect(reply.body).toBe('');
        expect(reply.location).toBe('/support/sent');
        const sent = await browser.request(reply.location ?? '');
        expect(sent.status).toBe(200);
        expect(sent.body).toContain('TICKET_SENT');
        for (const page of [reply.body, sent.body]) {
          expect(page).not.toContain('<script>alert');
          expect(page).not.toContain('onerror');
          expect(page).not.toContain(FAKE_CONTACT);
        }
        expect(mailer.sent[0]?.body.endsWith(markup)).toBe(true);
      });
    });

    describe('a mailer that fails', () => {
      it('answers the shell refusal with nothing of the ticket, and logs the error name only', async () => {
        reset();
        mailer.failure = new Error(
          `transport refused ${FAKE_RECIPIENT} ${FAKE_CONTACT} ${SECRET_MESSAGE}`
        );
        const browser = await signedIn(app.origin, ORG_A);
        const reply = await post(browser, '/support/send', {
          contact: FAKE_CONTACT,
          message: SECRET_MESSAGE,
        });
        expect(reply.status).toBe(400);
        expect(reply.body).toBe('REFUSED');
        expect(reply.location).toBeNull();
        expect(errorLines).toEqual([
          JSON.stringify({ event: 'portal.error', step: 'action', error: 'SupportTicketError' }),
        ]);
        for (const secret of [FAKE_CONTACT, FAKE_RECIPIENT, FAKE_SENDER, SECRET_MESSAGE]) {
          expect(reply.body).not.toContain(secret);
          expect(errorLines.join('\n')).not.toContain(secret);
        }
      });
    });

    if (breakRead !== undefined) {
      describe('a read that fails', () => {
        afterEach(() => breakRead(undefined));

        it.each(['ownRegistration', 'ownHealth'] as const)(
          'answers the shell refusal when %s rejects, sends nothing and logs the error name only',
          async (read) => {
            reset();
            const browser = await signedIn(app.origin, ORG_A);
            breakRead(
              read,
              new Error(`connection refused ${TENANT_A} ${FAKE_CONTACT} ${SECRET_MESSAGE}`)
            );
            const reply = await post(browser, '/support/send', {
              contact: FAKE_CONTACT,
              message: SECRET_MESSAGE,
            });
            expect(reply.status).toBe(400);
            expect(reply.body).toBe('REFUSED');
            expect(reply.location).toBeNull();
            expect(mailer.sent).toHaveLength(0);
            expect(errorLines).toEqual([
              JSON.stringify({
                event: 'portal.error',
                step: 'action',
                error: 'SupportTicketError',
              }),
            ]);
            for (const secret of [TENANT_A, FAKE_CONTACT, FAKE_RECIPIENT, SECRET_MESSAGE]) {
              expect(reply.body).not.toContain(secret);
              expect(errorLines.join('\n')).not.toContain(secret);
            }
          }
        );
      });
    }

    describe('with no mailer injected', () => {
      it.each([
        '/support',
        '/support/home',
        '/support/documents',
        '/support/moderation',
        '/support/sent',
        '/support/limited',
      ])('answers 404 for the page %s', async (path) => {
        const browser = await signedIn(plain.origin, ORG_A);
        expect((await browser.request(path)).status).toBe(404);
      });

      it.each(['/support/send', '/support/home/send', '/support/documents/send'])(
        'answers 404 for a post to %s',
        async (path) => {
          reset();
          const browser = await signedIn(plain.origin, ORG_A);
          const reply = await browser.request(path, {
            method: 'POST',
            headers: { origin: plain.origin, 'content-type': FORM },
            body: new URLSearchParams(ticketFields()).toString(),
          });
          expect(reply.status).toBe(404);
          expect(mailer.sent).toHaveLength(0);
        }
      );

      it.each(['/', '/documents', '/moderation'])(
        'shows no support item or link on %s',
        async (path) => {
          const browser = await signedIn(plain.origin, ORG_A);
          const page = await browser.request(path);
          expect(page.status).toBe(200);
          expect(page.body).not.toContain('NAV_SUPPORT');
          expect(page.body).not.toContain('SUPPORT_LINK');
          expect(page.body).not.toContain('/support');
        }
      );
    });
  });
}
