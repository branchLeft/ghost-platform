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

  it('shows an open request as its status word and no button, and no time', () => {
    const html = renderSupportAccess(
      { state: 'closed', deadline: null },
      { requestedAt: ASKED, status: 'open' }
    );
    expect(html).toContain('SUPPORT_ACCESS_REQUEST_SENT');
    expect(html).toContain('SUPPORT_REQUEST_STATUS_OPEN');
    expect(html).not.toContain('SUPPORT_REQUEST_STATUS_DEALT_WITH');
    expect(html).not.toContain('2027-01-15T07:30:00.000Z');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });

  it('shows a request dealt with as that word and offers the one button again', () => {
    const html = renderSupportAccess(
      { state: 'closed', deadline: null },
      { requestedAt: ASKED, status: 'dealt_with' }
    );
    expect(html).toContain('SUPPORT_REQUEST_STATUS_DEALT_WITH');
    expect(html).not.toContain('SUPPORT_REQUEST_STATUS_OPEN');
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html).toContain('<form method="post" action="/site-access/request">');
    expect(html).not.toMatch(/<input|<textarea|<select/);
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('shows a status it does not know as neither word', () => {
    const html = renderSupportAccess(
      { state: 'closed', deadline: null },
      { requestedAt: ASKED, status: 'bogus' }
    );
    expect(html).toContain('SUPPORT_REQUEST_STATUS_UNKNOWN');
    expect(html).not.toContain('SUPPORT_REQUEST_STATUS_DEALT_WITH');
    expect(html).not.toContain('<form');
  });

  it('offers no way to end access from the page, and points at the placeholders for how', () => {
    const html = renderSupportAccess({ state: 'open', deadline: DEADLINE }, null);
    expect(html).toContain('SUPPORT_ACCESS_OWNER_CLOSES');
    expect(html).toContain('SUPPORT_ACCESS_STOP_NOW');
    expect(html).not.toMatch(/revoke|close-access|end-access/i);
  });
});

describe('renderSupportQueue', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('says so when no one has asked', () => {
    const html = renderSupportQueue([]);
    expect(html).toContain('SUPPORT_REQUESTS_PENDING 0');
    expect(html).not.toContain('<li>');
  });

  it('lists every request with the tenant, the time and the status, escaped, with no paging', () => {
    const html = renderSupportQueue([
      { tenantId: A, requestedAt: ASKED, status: 'open' },
      { tenantId: '<b>', requestedAt: DEADLINE, status: 'open' },
    ]);
    expect(html).toContain('SUPPORT_REQUESTS_PENDING 2');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain(A);
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toMatch(/page=|next|previous/i);
  });

  it('counts only the open ones as pending and keeps the order it is given', () => {
    const html = renderSupportQueue([
      { tenantId: A, requestedAt: ASKED, status: 'open' },
      { tenantId: B, requestedAt: DEADLINE, status: 'dealt_with' },
    ]);
    expect(html).toContain('SUPPORT_REQUESTS_PENDING 1');
    expect(html.indexOf(A)).toBeLessThan(html.indexOf(B));
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it('gives each open request one mark-as-dealt-with form naming its tenant, and a dealt-with one none', () => {
    const html = renderSupportQueue([
      { tenantId: A, requestedAt: ASKED, status: 'open' },
      { tenantId: B, requestedAt: DEADLINE, status: 'dealt_with' },
    ]);
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html).toContain(
      `<form method="post" action="/support-requests/dealt-with"><input type="hidden" name="tenant" value="${A}">`
    );
    expect(html).toContain('SUPPORT_REQUEST_MARK_DEALT_WITH');
    expect(html).toContain('SUPPORT_REQUEST_STATUS_DEALT_WITH');
    expect(html).not.toMatch(/delete|remove/i);
  });
});
