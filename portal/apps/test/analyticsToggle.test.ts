import { describe, expect, it } from 'vitest';
import * as toggle from '../src/tenant/analyticsToggle.js';

describe('reader analytics default', () => {
  it('is off', () => {
    expect(toggle.READER_ANALYTICS_DEFAULT_ENABLED).toBe(false);
    expect(toggle.readerAnalyticsDefault()).toEqual({ enabled: false });
  });
});

describe('reader analytics toggle screen', () => {
  const html = toggle.renderReaderAnalyticsToggle();

  it('shows the off option checked and the on option disabled', () => {
    expect(html).toMatch(/<input[^>]*value="off"[^>]*checked[^>]*>/);
    const onInput = html.match(/<input[^>]*value="on"[^>]*>/);
    expect(onInput).not.toBeNull();
    expect(onInput?.[0]).toContain('disabled');
    expect(onInput?.[0]).not.toContain('checked');
  });

  it('posts nowhere: no form, no submit control', () => {
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/type="submit"/i);
  });

  it('shows the owner scope sentences and the placeholders', () => {
    expect(html).toContain('analytics coming very soon!');
    expect(html).toContain('analytics data never leaves PublicPress');
    expect(html).toContain('ANALYTICS_TOGGLE_LABEL');
    expect(html).toContain('ANALYTICS_OFF_STATE_WORDING');
    expect(html).toContain('ANALYTICS_WHY_CLAUSE');
  });
});

describe('no code path turns reader analytics on', () => {
  it('exports exactly the default, its reader and the screen renderer', () => {
    expect(Object.keys(toggle).sort()).toEqual([
      'READER_ANALYTICS_DEFAULT_ENABLED',
      'readerAnalyticsDefault',
      'renderReaderAnalyticsToggle',
    ]);
  });

  it('takes no input that could enable it', () => {
    expect(toggle.renderReaderAnalyticsToggle.length).toBe(0);
    expect(toggle.readerAnalyticsDefault.length).toBe(0);
    expect(toggle.readerAnalyticsDefault().enabled).toBe(false);
  });
});
