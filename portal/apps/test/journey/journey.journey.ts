import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRig, type Rig } from './rig.js';
import { JOURNEY } from './steps/index.js';
import { StepFailure, walk, type JourneyContext, type JourneyStep } from './walk.js';

// The portal's journey in a real browser: the portal on its data layer, the
// HTTP test identity provider, and one screenshot per screen in
// JOURNEY_SCREENSHOT_DIR (default `journey-screenshots`, which CI uploads).

const OUT = resolve(process.env['JOURNEY_SCREENSHOT_DIR'] ?? 'journey-screenshots');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let rig: Rig;
let browser: Browser;
let page: Page;

const context = (): JourneyContext => ({
  page,
  portalOrigin: rig.portalOrigin,
  idpOrigin: rig.idp.issuer,
  demoTenantId: rig.demoTenantId,
});

beforeAll(async () => {
  rig = await startRig();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await rig?.close();
});

async function freshPage(): Promise<void> {
  page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
}

describe('the portal journey in a browser', () => {
  it('walks every screen in order and saves one screenshot of each', async () => {
    await freshPage();
    const results = await walk(JOURNEY, context(), `${OUT}/journey`);
    expect(results.map((r) => r.id)).toEqual(JOURNEY.map((s) => s.id));
    for (const { screenshot } of results) {
      expect(readFileSync(screenshot).subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    }
    expect(await page.locator('body').innerText()).toContain(rig.demoTenantId);
  });

  it('fails a step whose screen lacks its expected placeholder, naming it', async () => {
    await freshPage();
    const sabotaged: JourneyStep[] = JOURNEY.map((step) =>
      step.id === 'tenant-home' ? { ...step, expect: [...step.expect, 'NOT_ON_THIS_SCREEN'] } : step
    );
    const failure = await walk(sabotaged, context(), `${OUT}/control`).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StepFailure);
    expect((failure as StepFailure).stepId).toBe('tenant-home');
    expect((failure as StepFailure).problems).toEqual(['missing NOT_ON_THIS_SCREEN']);
    expect((failure as StepFailure).screenshot).toMatch(/02-tenant-home-FAILED\.png$/);
  });

  it('fails a step whose screen shows text it must not', async () => {
    await freshPage();
    const sabotaged: JourneyStep[] = JOURNEY.map((step) =>
      step.id === 'tenant-home' ? { ...step, forbid: ['LANDING_PLACEHOLDER'] } : step
    );
    const failure = await walk(sabotaged, context(), `${OUT}/control`).catch((e: unknown) => e);
    expect((failure as StepFailure).problems).toEqual(['shows LANDING_PLACEHOLDER']);
  });
});
