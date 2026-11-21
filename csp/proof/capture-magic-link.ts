// The magic-link half of the content-policy proof: one real headless Chromium
// signs a reader up through Portal, reads the magic link out of the mail the
// tenant sent (to the spool, never to a real mailbox), follows it, and reports
// what it observed. It sets no policy and renders no verdict: the origin in
// front of Ghost sets the policy, and csp/gate/magic_link_verdict.py judges.
// The flow, and what it does not prove: csp/gate/csp-magic-link-gate.md.
// Run with Node 22.18 or later (it runs TypeScript as written).
import { chromium } from 'playwright';
import { findMagicLink, type SpooledMessage } from './mail-link.ts';

const ORIGIN = process.env['PROOF_ORIGIN'] ?? 'http://localhost:4331';
const LABEL = process.env['PROOF_LABEL'] ?? 'magic-link';
const EMAIL = process.env['PROOF_MEMBER_EMAIL'] ?? 'magic-link-member@example.test';
const DRAIN_URL = process.env['PROOF_DRAIN_URL'] ?? '';
const DRAIN_TOKEN = process.env['PROOF_DRAIN_TOKEN'] ?? '';
const PORTAL_FRAME = 'iframe[title="portal-popup"], iframe.gh-portal-popup-iframe';

interface Violation {
  readonly directive: string;
  readonly blockedURI: string;
  readonly disposition: string;
  readonly documentURI: string;
  readonly frame: string;
}

interface Capture {
  label: string;
  steps: string[];
  violations: Violation[];
  foreignRequests: string[];
  thirdPartyImages: string[];
  portalScriptUrl: string | null;
  mailTo: string | null;
  linkOrigin: string | null;
  finalUrl: string | null;
  memberSession: boolean;
  failedAt: string | null;
  error: string | null;
}

declare global {
  interface Window {
    __reportCsp: (violation: Omit<Violation, 'frame'>) => void;
  }
}

async function until<T>(
  description: string,
  attempt: () => Promise<T | null | undefined | false>,
  timeoutMs = 20000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// The spool hands each message out once; every message seen is kept here.
const seen: SpooledMessage[] = [];

async function drain(): Promise<void> {
  const auth = { authorization: `Bearer ${DRAIN_TOKEN}` };
  const res = await fetch(`${DRAIN_URL}/drain`, { headers: auth });
  if (!res.ok) throw new Error(`drain -> ${res.status}`);
  const body = (await res.json()) as {
    messages: {
      id: string;
      drainCount: number;
      to: string;
      subject: string;
      text: string;
      html: string;
    }[];
  };
  if (body.messages.length === 0) return;
  seen.push(...body.messages);
  await fetch(`${DRAIN_URL}/drain/ack`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      acks: body.messages.map((m) => ({ id: m.id, drainCount: m.drainCount })),
    }),
  });
}

async function magicLinkFor(email: string): Promise<{ link: string; message: SpooledMessage }> {
  return until(
    'the magic link in the spool',
    async () => {
      await drain();
      for (const message of seen) {
        if (message.to !== email) continue;
        for (const raw of [message.text, message.html]) {
          const link = findMagicLink(raw, ORIGIN);
          if (link !== null) return { link, message };
        }
      }
      return null;
    },
    30000
  );
}

async function main(): Promise<void> {
  const result: Capture = {
    label: LABEL,
    steps: [],
    violations: [],
    foreignRequests: [],
    thirdPartyImages: [],
    portalScriptUrl: null,
    mailTo: null,
    linkOrigin: null,
    finalUrl: null,
    memberSession: false,
    failedAt: null,
    error: null,
  };
  if (DRAIN_URL === '' || DRAIN_TOKEN === '') {
    console.error('capture-magic-link: PROOF_DRAIN_URL and PROOF_DRAIN_TOKEN are required');
    process.exit(2);
  }
  const ownHost = new URL(ORIGIN).host;
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // From EVERY frame (Portal is an iframe), through a context binding rather than a
  // per-page array, so a blocked script inside Portal's frame cannot hide.
  await context.exposeBinding('__reportCsp', (source, violation: Omit<Violation, 'frame'>) => {
    result.violations.push({ ...violation, frame: source.frame.url() });
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__reportCsp({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
        disposition: e.disposition,
        documentURI: e.documentURI,
      });
    });
  });
  // Every request the browser tried, so a widget on a third party shows even where
  // the policy would allow it.
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol) || url.host === ownHost) return;
    // An image from any https origin is allowed by the policy, so those are listed on
    // their own; anything else off the origin is a request the policy let through.
    if (request.resourceType() === 'image') {
      const image = `${url.origin}${url.pathname}`;
      if (!result.thirdPartyImages.includes(image)) result.thirdPartyImages.push(image);
      return;
    }
    result.foreignRequests.push(`${request.resourceType()} ${url.origin}`);
  });
  context.on('response', (response) => {
    if (/\/portal(\.min)?\.js(\?|$)/.test(response.url())) result.portalScriptUrl = response.url();
  });

  const page = await context.newPage();
  const step = (name: string): void => {
    result.steps.push(name);
  };

  try {
    // 1. Portal's sign-up form, filled in and sent.
    await page.goto(`${ORIGIN}/#/portal/signup`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector(PORTAL_FRAME, { timeout: 15000 });
    const portal = page.frameLocator(PORTAL_FRAME);
    const emailField = portal.locator('input[type="email"]').first();
    await emailField.waitFor({ timeout: 15000 });
    step('signup-form-shown');
    await portal.locator('input[name="name"]').first().fill('Magic Link Member');
    await emailField.fill(EMAIL);
    await portal
      .getByRole('button', { name: /sign up/i })
      .first()
      .click();
    await portal
      .getByText(/check your email/i)
      .first()
      .waitFor({ timeout: 20000 });
    step('signup-sent');

    // 2. The mail the tenant sent to the spool, and the link in it.
    const { link, message } = await magicLinkFor(EMAIL);
    result.mailTo = message.to;
    result.linkOrigin = new URL(link).origin;
    step('magic-link-mailed');

    // 3. Follow it. Ghost checks the token and sends the browser back to the site.
    await page.goto(link, { waitUntil: 'networkidle', timeout: 30000 });
    result.finalUrl = page.url().replace(/token=[^&#]*/g, 'token=redacted');
    step('magic-link-followed');

    // 4. Ghost serves a member session for the address that signed up.
    const me = await until('a member session', async () => {
      const res = await page.request.get(`${ORIGIN}/members/api/member/`);
      return res.ok() ? ((await res.json()) as { email?: string }) : null;
    });
    result.memberSession = me.email === EMAIL;
    if (result.memberSession) step('member-session');

    // 5. Portal reopens on the signed-in site: its account page renders for the member.
    await page.goto(`${ORIGIN}/#/portal/account`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector(PORTAL_FRAME, { timeout: 15000 });
    await page.frameLocator(PORTAL_FRAME).getByText(EMAIL).first().waitFor({ timeout: 15000 });
    step('portal-account-shown');
    await page.waitForTimeout(1500); // let any deferred reports land
  } catch (err) {
    const last = result.steps[result.steps.length - 1];
    result.failedAt = last === undefined ? 'start' : `after ${last}`;
    result.error = String(err instanceof Error ? err.message : err).split('\n')[0] ?? 'failed';
    if (process.env['PROOF_DEBUG'] === '1') {
      for (const frame of page.frames()) {
        const text = await frame
          .locator('body')
          .innerText({ timeout: 2000 })
          .catch(() => '');
        console.error(`[debug] frame ${frame.url()}\n${text.slice(0, 600)}`);
      }
    }
  }

  await browser.close();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
