import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

/** What a step may use. Grows as screens are added; nothing here is global state. */
export interface JourneyContext {
  readonly page: Page;
  /** The tenant portal's origin. */
  readonly portalOrigin: string;
  /** The test identity provider's origin. */
  readonly idpOrigin: string;
  /** The demo tenant's id, as the portal's home shows it. */
  readonly demoTenantId: string;
}

/**
 * One screen of the journey. To add a screen, add one of these to the list in
 * `steps/index.ts`: drive the page there in `go`, name the placeholder text it
 * must show in `expect`, and the walk takes its screenshot.
 */
export interface JourneyStep {
  /** Kebab-case; the screenshot is `<position>-<id>.png`. */
  readonly id: string;
  /** Moves the browser to the screen. It asserts nothing; `expect` does. */
  readonly go: (context: JourneyContext) => Promise<void>;
  /** Text the screen must show. Missing any one fails the step. */
  readonly expect: readonly string[];
  /** Text the screen must not show. */
  readonly forbid?: readonly string[];
}

export interface StepResult {
  readonly id: string;
  readonly screenshot: string;
}

export class StepFailure extends Error {
  constructor(
    readonly stepId: string,
    readonly problems: readonly string[],
    readonly screenshot: string
  ) {
    super(`step "${stepId}" failed: ${problems.join('; ')} (screenshot ${screenshot})`);
    this.name = 'StepFailure';
  }
}

const position = (index: number): string => String(index + 1).padStart(2, '0');

/**
 * Walks the steps in order, one screenshot each, full page. A step whose
 * screen lacks expected text (or shows forbidden text) is saved as
 * `<position>-<id>-FAILED.png` and stops the walk with a `StepFailure`.
 */
export async function walk(
  steps: readonly JourneyStep[],
  context: JourneyContext,
  outDir: string
): Promise<StepResult[]> {
  mkdirSync(outDir, { recursive: true });
  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    await step.go(context);
    const text = await context.page.locator('body').innerText();
    const problems = [
      ...step.expect.filter((want) => !text.includes(want)).map((want) => `missing ${want}`),
      ...(step.forbid ?? []).filter((no) => text.includes(no)).map((no) => `shows ${no}`),
    ];
    const name = `${position(index)}-${step.id}${problems.length === 0 ? '' : '-FAILED'}.png`;
    const file = join(outDir, name);
    writeFileSync(file, await context.page.screenshot({ fullPage: true }));
    if (problems.length > 0) throw new StepFailure(step.id, problems, file);
    results.push({ id: step.id, screenshot: file });
  }
  return results;
}
