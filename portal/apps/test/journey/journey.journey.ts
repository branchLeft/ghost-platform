import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startRig, type Rig } from './rig.js';
import { JOURNEY, PROFESSIONAL_JOURNEY, WITHOUT_APPROVE } from './steps/index.js';
import { targetFromEnv } from './target.js';
import { StepFailure, walk, type JourneyContext, type JourneyStep } from './walk.js';

// The portal's journey in a real browser: the tenant portal and the owner
// console as their own processes (from `dist/`, or from the image named by
// JOURNEY_IMAGE), the HTTP test identity provider, the provisioning mock and a
// mail double, and one screenshot per screen in JOURNEY_SCREENSHOT_DIR
// (default `journey-screenshots`, which CI uploads). Each test gets its own rig,
// so none depends on what another left in the database or the mock.

const OUT = resolve(process.env['JOURNEY_SCREENSHOT_DIR'] ?? 'journey-screenshots');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const target = targetFromEnv(process.env);

let browser: Browser;
let started: Rig | undefined;
let contexts: BrowserContext[] = [];

async function newContext(): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  return context;
}

function rigOf(): Rig {
  if (started === undefined) throw new Error('the rig did not start');
  return started;
}

/** Two browsers' worth of state: the tenant's administrator and the owner never share cookies. */
async function journeyContext(): Promise<JourneyContext> {
  const rig = rigOf();
  return {
    pages: {
      tenant: await (await newContext()).newPage(),
      owner: await (await newContext()).newPage(),
    },
    portalOrigin: rig.portalOrigin,
    consoleOrigin: rig.consoleOrigin,
    idpOrigin: rig.idp.issuer,
    demoTenantId: rig.demoTenantId,
  };
}

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  started = await startRig(target);
});

afterEach(async (test) => {
  // A failed test's first clue is what the applications said.
  if (started !== undefined && test.task.result?.state === 'fail') {
    process.stderr.write(`${started.logs()}\n`);
  }
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  contexts = [];
  await started?.close();
  started = undefined;
});

describe(`the portal journey in a browser (${target.kind === 'image' ? target.reference : 'built checkout'})`, () => {
  it('walks every screen in order, with the owner approving in the console, and saves one screenshot of each', async () => {
    const context = await journeyContext();
    const results = await walk(JOURNEY, context, `${OUT}/journey`);
    expect(results.map((r) => r.id)).toEqual(JOURNEY.map((s) => s.id));
    for (const { screenshot } of results) {
      expect(readFileSync(screenshot).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    }
    // The tenant's own id, from the portal's home; nothing from a request chose it.
    await context.pages.tenant.goto(`${rigOf().portalOrigin}/`);
    expect(await context.pages.tenant.locator('body').innerText()).toContain(rigOf().demoTenantId);
  });

  it('control: with Approve skipped, the Essentials site screen shows the demo placeholder and the walk fails', async () => {
    const context = await journeyContext();
    const failure = await walk(WITHOUT_APPROVE, context, `${OUT}/control-no-approve`).catch(
      (e: unknown) => e
    );
    expect(failure).toBeInstanceOf(StepFailure);
    const step = failure as StepFailure;
    expect(step.stepId).toBe('essentials-site');
    expect(step.problems).toContain('missing SITE_TITLE');
    expect(step.problems).toContain('shows SITE_NOT_PROMOTED');
    expect(step.screenshot).toMatch(/essentials-site-FAILED\.png$/);
    expect(await context.pages.tenant.locator('body').innerText()).toContain('SITE_NOT_PROMOTED');
  });

  it('control: with placeholders not allowed, no screen shows the third-party-off copy, the form and the site still stand, and the portal says what it withholds', async () => {
    await started?.close();
    started = await startRig(target, { allowPlaceholderCopy: false });
    const context = await journeyContext();
    const failure = await walk(JOURNEY, context, `${OUT}/control-no-placeholder-copy`).catch(
      (e: unknown) => e
    );
    expect(failure).toBeInstanceOf(StepFailure);
    const step = failure as StepFailure;
    expect(step.stepId).toBe('ask-for-essentials');
    expect(step.problems).toEqual(['missing THIRD_PARTY_OFF_ONBOARDING_LINE']);
    const text = await context.pages.tenant.locator('body').innerText();
    expect(text).toContain('REQUEST_ESSENTIALS');
    expect(text).not.toContain('THIRD_PARTY_OFF');
    expect(rigOf().logs()).toContain('portal.copy_withheld');
  });

  it('the Professional enquiry ends at its confirmation with the mail double holding one message', async () => {
    const context = await journeyContext();
    const results = await walk(PROFESSIONAL_JOURNEY, context, `${OUT}/professional`);
    expect(results.map((r) => r.id)).toEqual(PROFESSIONAL_JOURNEY.map((s) => s.id));
    const { mail, demoTenantId } = rigOf();
    await expect.poll(() => mail.delivered.length).toBe(1);
    const [message] = mail.delivered;
    expect(message?.raw).toContain(`PROFESSIONAL_ENQUIRY ${demoTenantId}`);
    expect(message?.raw).toContain('JOURNEY_ENQUIRY_MESSAGE');
  });

  it('fails a step whose screen lacks its expected placeholder, naming it', async () => {
    const context = await journeyContext();
    const sabotaged: JourneyStep[] = JOURNEY.map((step) =>
      step.id === 'tenant-home' ? { ...step, expect: [...step.expect, 'NOT_ON_THIS_SCREEN'] } : step
    );
    const failure = await walk(sabotaged, context, `${OUT}/control-missing-text`).catch(
      (e: unknown) => e
    );
    expect(failure).toBeInstanceOf(StepFailure);
    expect((failure as StepFailure).stepId).toBe('tenant-home');
    expect((failure as StepFailure).problems).toEqual(['missing NOT_ON_THIS_SCREEN']);
    expect((failure as StepFailure).screenshot).toMatch(/02-tenant-home-FAILED\.png$/);
  });

  it('fails a step whose screen shows text it must not', async () => {
    const context = await journeyContext();
    const sabotaged: JourneyStep[] = JOURNEY.map((step) =>
      step.id === 'tenant-home' ? { ...step, forbid: ['LANDING_PLACEHOLDER'] } : step
    );
    const failure = await walk(sabotaged, context, `${OUT}/control-forbidden-text`).catch(
      (e: unknown) => e
    );
    expect((failure as StepFailure).problems).toEqual(['shows LANDING_PLACEHOLDER']);
  });
});
