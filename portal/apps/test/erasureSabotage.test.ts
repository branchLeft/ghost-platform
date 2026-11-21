import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderErasure } from '../src/shell/erasureHtml.js';
import { problemsAfterKeyDestroyed, problemsBeforeKeyDestroyed } from './erasureHonesty.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

interface HtmlModule {
  readonly renderErasure: typeof renderErasure;
}

const MODULE = 'shell/erasureHtml.ts';
const REQUESTED = new Date('2027-01-14T09:00:00.000Z');
const DESTROYED = new Date('2027-01-16T09:00:00.000Z');
const WINDOW = {
  aroundDays: 46,
  upperBoundDays: null,
  reason: 'ANCHOR_DUMP_NEVER_PRUNED',
} as const;

const waiting = { state: 'requested', requestedAt: REQUESTED } as const;
const destroyed = {
  state: 'key_destroyed',
  requestedAt: REQUESTED,
  keyDestroyedAt: DESTROYED,
  residual: WINDOW,
} as const;

const before = (render: typeof renderErasure) =>
  problemsBeforeKeyDestroyed(render(waiting), REQUESTED.toISOString());
const after = (render: typeof renderErasure) =>
  problemsAfterKeyDestroyed(render(destroyed), REQUESTED.toISOString(), DESTROYED.toISOString());

beforeAll(clearMutants);
afterAll(clearMutants);

describe('sabotage: the erasure page never says more than the record proves', () => {
  it('GREEN: the real page passes both honesty checks', () => {
    expect(before(renderErasure)).toEqual([]);
    expect(after(renderErasure)).toEqual([]);
  });

  it('the helper refuses a mutation that changes nothing', async () => {
    await expect(importSabotaged('erasure-noop', 'not in the module', 'x', MODULE)).rejects.toThrow(
      'exactly once'
    );
  });

  it('RED: a page that says the data is deleted while the request only waits is caught', async () => {
    const broken = await importSabotaged<HtmlModule>(
      'erasure-says-deleted',
      "'<p>ERASURE_STATUS_REQUESTED</p><p>ERASURE_NOTHING_ERASED_YET</p>'",
      "'<p>ERASURE_STATUS_REQUESTED</p><p>ERASURE_DELETED</p>'",
      MODULE
    );
    const problems = before(broken.renderErasure);
    expect(problems).toContain('does not say nothing is erased');
    expect(problems).toContain('uses a word for the data being gone');
  });

  it('RED: a page that shows the residual window before the key is destroyed is caught', async () => {
    const broken = await importSabotaged<HtmlModule>(
      'erasure-window-early',
      "'<p>ERASURE_STATUS_REQUESTED</p><p>ERASURE_NOTHING_ERASED_YET</p>'",
      "'<p>ERASURE_STATUS_KEY_DESTROYED</p><p>ERASURE_NOTHING_ERASED_YET</p><p>ERASURE_RESIDUAL_NO_UPPER_BOUND</p>'",
      MODULE
    );
    const problems = before(broken.renderErasure);
    expect(problems.join('|')).toContain('before the key is recorded destroyed');
  });

  it('RED: a page that puts a date on the end of the window is caught', async () => {
    const broken = await importSabotaged<HtmlModule>(
      'erasure-end-date',
      '<dd>${view.residual.aroundDays}</dd></dl>',
      '<dd>${view.residual.aroundDays}</dd><dt>ERASURE_RESIDUAL_ENDS</dt><dd>${time(new Date(view.keyDestroyedAt.getTime() + view.residual.aroundDays * 86400000))}</dd></dl>',
      MODULE
    );
    const problems = after(broken.renderErasure);
    expect(problems).toContain('prints a date that is neither recorded moment');
    expect(problems).toContain('claims a bound');
  });

  it('RED: a page that leaves out "no upper bound" is caught', async () => {
    const broken = await importSabotaged<HtmlModule>(
      'erasure-no-bound-line',
      "'<p>ERASURE_RESIDUAL_NO_UPPER_BOUND</p>' +",
      "'' +",
      MODULE
    );
    expect(after(broken.renderErasure)).toContain('does not say ERASURE_RESIDUAL_NO_UPPER_BOUND');
  });

  it('RED: a page that leaves out the reason is caught', async () => {
    const broken = await importSabotaged<HtmlModule>(
      'erasure-no-reason',
      '`<p>${reasonLabel(view.residual.reason)}</p>`',
      "''",
      MODULE
    );
    expect(after(broken.renderErasure)).toContain(
      'does not say ERASURE_RESIDUAL_REASON_ANCHOR_DUMP_NEVER_PRUNED'
    );
  });

  it('RED: a page that still says nothing is erased once the key is destroyed is caught', async () => {
    const broken = await importSabotaged<HtmlModule>(
      'erasure-stale-line',
      "'<p>ERASURE_STATUS_KEY_DESTROYED</p>' +",
      "'<p>ERASURE_STATUS_KEY_DESTROYED</p><p>ERASURE_NOTHING_ERASED_YET</p>' +",
      MODULE
    );
    expect(after(broken.renderErasure)).toContain('still says nothing is erased');
  });
});
