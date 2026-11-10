import { describe, expect, it } from 'vitest';
import { renderSupportAccess, renderSupportQueue } from '../src/shell/supportAccessHtml.js';

const DEADLINE = new Date('2027-01-15T12:00:00Z');
const ASKED = new Date('2027-01-15T07:30:00Z');

describe('renderSupportAccess', () => {
  it('shows an open reading with its deadline', () => {
    const html = renderSupportAccess({ state: 'open', deadline: DEADLINE }, null);
    expect(html).toContain('SUPPORT_ACCESS_STATE_OPEN');
    expect(html).toContain('SUPPORT_ACCESS_DEADLINE');
    expect(html).toContain('2027-01-15T12:00:00.000Z');
    expect(html).not.toContain('SUPPORT_ACCESS_STATE_CLOSED');
    expect(html).not.toContain('SUPPORT_ACCESS_STATE_UNKNOWN');
  });

  it('says so when an open reading carries no deadline, and invents none', () => {
    const html = renderSupportAccess({ state: 'open', deadline: null }, null);
    expect(html).toContain('SUPPORT_ACCESS_STATE_OPEN');
    expect(html).toContain('SUPPORT_ACCESS_DEADLINE_UNKNOWN');
    expect(html).not.toContain('<time');
  });

  it('shows a closed reading with no deadline, even if one is handed in', () => {
    const html = renderSupportAccess({ state: 'closed', deadline: DEADLINE }, null);
    expect(html).toContain('SUPPORT_ACCESS_STATE_CLOSED');
    expect(html).not.toContain('SUPPORT_ACCESS_DEADLINE');
    expect(html).not.toContain('2027-01-15T12:00:00.000Z');
  });

  it('shows unknown as unknown and never as closed', () => {
    const html = renderSupportAccess({ state: 'unknown', deadline: null }, null);
    expect(html).toContain('SUPPORT_ACCESS_STATE_UNKNOWN');
    expect(html).not.toContain('SUPPORT_ACCESS_STATE_CLOSED');
    expect(html).not.toContain('SUPPORT_ACCESS_STATE_OPEN');
  });

  it.each(['locked', '', 'CLOSED', 'bogus'])(
    'shows the state %j, which it does not know, as unknown',
    (state) => {
      const html = renderSupportAccess({ state, deadline: DEADLINE }, null);
      expect(html).toContain('SUPPORT_ACCESS_STATE_UNKNOWN');
      expect(html).not.toContain('SUPPORT_ACCESS_STATE_CLOSED');
      expect(html).not.toContain('2027-01-15T12:00:00.000Z');
    }
  );

  it('offers one button that asks, and no field, no text and no other action', () => {
    const html = renderSupportAccess({ state: 'closed', deadline: null }, null);
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html).toContain('<form method="post" action="/site-access/request">');
    expect(html).toContain('SUPPORT_ACCESS_REQUEST_BUTTON');
    expect(html).not.toMatch(/<input|<textarea|<select/);
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('shows a pending request and no button', () => {
    const html = renderSupportAccess({ state: 'closed', deadline: null }, { requestedAt: ASKED });
    expect(html).toContain('SUPPORT_ACCESS_REQUEST_SENT');
    expect(html).toContain('2027-01-15T07:30:00.000Z');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });

  it('offers no way to end access from the page, and points at the placeholders for how', () => {
    const html = renderSupportAccess({ state: 'open', deadline: DEADLINE }, null);
    expect(html).toContain('SUPPORT_ACCESS_OWNER_CLOSES');
    expect(html).toContain('SUPPORT_ACCESS_STOP_NOW');
    expect(html).not.toMatch(/revoke|close-access|end-access/i);
  });
});

describe('renderSupportQueue', () => {
  it('says so when no one has asked', () => {
    const html = renderSupportQueue([]);
    expect(html).toContain('SUPPORT_REQUESTS_PENDING 0');
    expect(html).not.toContain('<li>');
  });

  it('lists every request with the tenant and the time, escaped, with no paging', () => {
    const html = renderSupportQueue([
      { tenantId: '11111111-1111-4111-8111-111111111111', requestedAt: ASKED },
      { tenantId: '<b>', requestedAt: DEADLINE },
    ]);
    expect(html).toContain('SUPPORT_REQUESTS_PENDING 2');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('11111111-1111-4111-8111-111111111111');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/page=|next|previous/i);
  });
});
