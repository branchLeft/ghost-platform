import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The README states the latch rules the code has; it must not say login mail ignores the latch again. */

const readme = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'README.md'),
  'utf8'
);
// Line breaks and runs of spaces are layout, not wording.
const flat = readme.replace(/\s+/g, ' ');

describe('the README latch wording', () => {
  it.each([
    /login mail never consults (the tenant's |the )?latch/i,
    /sign-in (mail|links?) never consults? (the tenant's |the )?latch/i,
    /login mail (is )?unaffected by the (tenant )?latch/i,
    /login mail (it )?still goes to sweego/i,
    /keeps going to Sweego; it is counted/i,
    /supplies the allowance as reached only for bulk/i,
  ])('does not say login mail ignores the latch: %s', (old) => {
    expect(flat).not.toMatch(old);
  });

  it('says a latched tenant sign-in links move with its newsletters', () => {
    expect(flat).toMatch(/sign-in links and its newsletters then go to mx1/);
  });

  it('names the newsletter threshold, the suspension latch and the owner file', () => {
    for (const name of [
      'COLLECTOR_SWEEGO_NEWSLETTER_CAP',
      'COLLECTOR_SWEEGO_SUSPENSION_STATE_PATH',
      'COLLECTOR_SWEEGO_SUSPEND_FILE_PATH',
      'sweegoSuspension createSweegoSuspension',
      'newsletterThresholdReached',
    ]) {
      expect(readme).toContain(name);
    }
  });
});
