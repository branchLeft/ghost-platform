import { describe, expect, it } from 'vitest';
import { parseDsn, toOutcome } from '../../src/dsn.js';

const MESSAGE_ID = '<4cfbf575-9efc-4508-bc4f-e0f9314e4844.1@746e616e742d61.outcomes.invalid>';

function dsn(fields: string, originalId: string | null = MESSAGE_ID): string {
  return [
    'From: MAILER-DAEMON@mx1.example.invalid',
    'Message-ID: <dsn-own-id@mx1.example.invalid>',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain',
    '',
    'Human readable text.',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx1.example.invalid',
    '',
    fields,
    '',
    '--B',
    'Content-Type: text/rfc822-headers',
    '',
    'From: noreply@tenant.example',
    ...(originalId ? [`Message-ID: ${originalId}`] : []),
    'Subject: Hi',
    '',
    '--B--',
    '',
  ].join('\r\n');
}

describe('parseDsn', () => {
  it('reads the final recipient group and the ORIGINAL Message-ID, not the notification own id', () => {
    const parsed = parseDsn(
      dsn(
        [
          'Final-Recipient: rfc822; gone@example.com',
          'Action: failed',
          'Status: 5.1.1',
          'Diagnostic-Code: smtp; 550 5.1.1 no such user',
        ].join('\r\n')
      )
    );
    expect(parsed).toEqual({
      originalMessageId: MESSAGE_ID,
      action: 'failed',
      status: '5.1.1',
      diagnostic: 'smtp; 550 5.1.1 no such user',
    });
  });

  it('unfolds a folded Diagnostic-Code', () => {
    const parsed = parseDsn(
      dsn('Action: failed\r\nStatus: 5.2.2\r\nDiagnostic-Code: smtp; 552\r\n mailbox full')
    );
    expect(parsed?.diagnostic).toBe('smtp; 552 mailbox full');
  });

  it.each([
    ['plain mail', 'From: a@b\r\nSubject: x\r\n\r\nbody'],
    ['a DSN with no Action', dsn('Status: 5.1.1')],
    ['a DSN with no Status', dsn('Action: failed')],
    [
      'a DSN that does not quote the original headers',
      dsn('Action: failed\r\nStatus: 5.1.1', null),
    ],
  ])('returns null for %s', (_name, raw) => {
    expect(parseDsn(raw)).toBeNull();
  });
});

describe('toOutcome', () => {
  const base = { originalMessageId: MESSAGE_ID, diagnostic: null };

  it('delivered with a 2.x.x status is delivered', () => {
    expect(toOutcome({ ...base, action: 'delivered', status: '2.0.0' })).toEqual({
      outcome: 'delivered',
    });
  });

  it('delivered with any other status is NOT delivered: a malformed report cannot mark mail delivered', () => {
    expect(toOutcome({ ...base, action: 'delivered', status: '5.0.0' })).toBeNull();
    expect(toOutcome({ ...base, action: 'delivered', status: 'garbage' })).toBeNull();
  });

  it('relayed and expanded are not delivery: they hand off to a system that will not report', () => {
    expect(toOutcome({ ...base, action: 'relayed', status: '2.0.0' })).toBeNull();
    expect(toOutcome({ ...base, action: 'expanded', status: '2.0.0' })).toBeNull();
  });

  it('failed 5.x.x is permanent and carries the SMTP code and diagnostic', () => {
    expect(
      toOutcome({
        ...base,
        action: 'failed',
        status: '5.1.1',
        diagnostic: 'smtp; 550 5.1.1 no such user',
      })
    ).toEqual({
      outcome: 'failed',
      severity: 'permanent',
      code: 550,
      message: 'smtp; 550 5.1.1 no such user',
    });
  });

  it('failed is permanent ONLY with an explicit 5.x.x: a malformed status cannot suppress an address', () => {
    for (const status of ['', 'garbage', '2.0.0', '3.1.1', '55.1', '5']) {
      expect(toOutcome({ ...base, action: 'failed', status })).toBeNull();
    }
    expect(toOutcome({ ...base, action: 'failed', status: '5.7.1' })).toMatchObject({
      severity: 'permanent',
    });
  });

  it('failed 4.x.x and delayed are temporary', () => {
    expect(toOutcome({ ...base, action: 'failed', status: '4.2.2' })).toMatchObject({
      outcome: 'failed',
      severity: 'temporary',
    });
    expect(toOutcome({ ...base, action: 'delayed', status: '4.4.1' })).toMatchObject({
      outcome: 'failed',
      severity: 'temporary',
    });
  });

  it('truncates an overlong diagnostic', () => {
    const out = toOutcome({
      ...base,
      action: 'failed',
      status: '5.0.0',
      diagnostic: 'x'.repeat(900),
    });
    expect(out?.message).toHaveLength(500);
  });
});
