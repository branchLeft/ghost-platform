/**
 * The reader analytics toggle on the tenant onboarding screen. Reader analytics
 * is off for every new site. This screen shows the off state (selected) and the
 * on state (present, disabled). There is no form, no handler and no parameter
 * that can change the setting: enabling it is a later, separately gated change.
 */

/** A new site starts with reader analytics off. */
export const READER_ANALYTICS_DEFAULT_ENABLED = false;

export interface ReaderAnalyticsSetting {
  readonly enabled: boolean;
}

/** The setting a new site gets. Takes no input. */
export function readerAnalyticsDefault(): ReaderAnalyticsSetting {
  return { enabled: READER_ANALYTICS_DEFAULT_ENABLED };
}

/** The owner's scope sentences for this screen, reused verbatim. */
const SCOPE_INFO =
  'analytics coming very soon! We do not turn this on by default so you can decide what privacy guarantees you want to give readers, noting that analytics data never leaves PublicPress’ servers.';

/** The toggle screen, with the off state selected. Takes no input. */
export function renderReaderAnalyticsToggle(): string {
  return [
    '<fieldset class="reader-analytics">',
    '<legend>ANALYTICS_TOGGLE_LABEL</legend>',
    `<p>${SCOPE_INFO}</p>`,
    '<label><input type="radio" name="reader_analytics" value="off" checked> ANALYTICS_OFF_STATE_WORDING</label>',
    '<label><input type="radio" name="reader_analytics" value="on" disabled> ANALYTICS_ON_STATE_WORDING</label>',
    '<p>ANALYTICS_WHY_CLAUSE</p>',
    '</fieldset>',
  ].join('\n');
}
