import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARF_LIMITS, createArfReader, type ArfResult } from '../../src/arf/arfReader.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'arf');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const RECEIVED = Date.parse('2026-11-10T09:00:10Z');
const OURS = '<4cfbf575-9efc-4508-bc4f-e0f9314e4844.1@74656e616e742d61.outcomes.invalid>';

const read = createArfReader({
  trustedAuthservId: 'mx1.collector.example',
  sources: [{ name: 'example-fbl', dkimDomains: ['feedback-provider.example'] }],
});

const reasonOf = (r: ArfResult): string => (r.ok ? 'ok' : r.reason);
const full = (): string => fixture('abuse-full-original.eml');
const verdict = (raw: string): string => reasonOf(read(raw, RECEIVED));

/** Replaces text that must exist, so a stale mutation fails loudly instead of testing nothing. */
function swap(raw: string, from: string, to: string): string {
  expect(raw).toContain(from);
  return raw.replace(from, to);
}

describe('arfReader: a trustworthy report becomes a suppression record', () => {
  it('reads the full-original report: recipient, spool, message, source, our receive time', () => {
    expect(read(full(), RECEIVED)).toEqual({
      ok: true,
      record: {
        recipient: 'reader@example.com',
        targetId: 'tenant-a',
        id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844',
        drainCount: 1,
        source: 'example-fbl',
        timestampMs: RECEIVED,
        arrivalDateMs: Date.parse('2026-11-10T08:59:30Z'),
      },
    });
  });

  it('reads a headers-only report that names the recipient only in the quoted To, from a subdomain of the source', () => {
    const result = read(fixture('abuse-headers-only.eml'), RECEIVED);
    expect(result).toMatchObject({
      ok: true,
      record: {
        recipient: 'reader@example.com',
        drainCount: 3,
        source: 'example-fbl',
        arrivalDateMs: null,
      },
    });
  });

  it('reads the same report with CRLF line endings', () => {
    expect(verdict(full().replace(/\n/g, '\r\n'))).toBe('ok');
  });

  it('takes the timestamp from the caller, never from the sender, and drops an implausible Arrival-Date', () => {
    const future = swap(
      full(),
      'Arrival-Date: Tue, 10 Nov 2026 08:59:30 +0000',
      'Arrival-Date: Tue, 10 Nov 2036 08:59:30 +0000'
    );
    const result = read(future, RECEIVED);
    expect(result).toMatchObject({
      ok: true,
      record: { timestampMs: RECEIVED, arrivalDateMs: null },
    });
  });

  it('is not fooled by a nested multipart in the human part that carries another report', () => {
    const nested = swap(
      full(),
      'This is an email abuse report for a message received from IP 192.0.2.77.',
      [
        'Content-Type: multipart/mixed; boundary="inner"',
        '',
        '--inner',
        'Content-Type: message/feedback-report',
        '',
        'Version: 1',
        'Feedback-Type: abuse',
        'User-Agent: inner',
        'Original-Rcpt-To: victim@example.com',
        '--inner--',
      ].join('\n')
    );
    // Part 1 has its own header block; keep the original blank line so it parses as plain body.
    const result = read(nested, RECEIVED);
    expect(result).toMatchObject({ ok: true, record: { recipient: 'reader@example.com' } });
  });

  it('is not influenced by anything in the quoted original body', () => {
    const noisy = swap(
      full(),
      'Body of the original message that the provider quoted.',
      'Message-ID: <victim.9@74656e616e742d61.outcomes.invalid>\nTo: victim@example.com\nFeedback-Type: abuse'
    );
    expect(read(noisy, RECEIVED)).toMatchObject({ ok: true, record: { drainCount: 1 } });
  });
});

describe('arfReader: what is not a feedback report is not judged', () => {
  it.each([
    ['empty text', ''],
    ['plain mail', 'Subject: hi\n\nhello'],
    [
      'a delivery status notification',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B"\n\n--B\nContent-Type: message/delivery-status\n\nAction: failed\n--B--\n',
    ],
    [
      'a report-type claim on a non-report top level',
      'Content-Type: multipart/mixed; report-type=feedback-report; boundary="B"\n\n--B\n\nx\n--B--\n',
    ],
  ])('%s is not_arf', (_name, raw) => {
    expect(verdict(raw)).toBe('not_arf');
  });

  it('is not_arf when the caller clock is not a number', () => {
    expect(reasonOf(read(full(), Number.NaN))).toBe('not_arf');
  });
});

describe('arfReader: only an abuse report suppresses', () => {
  it('rejects a not-spam reversal', () => {
    expect(verdict(fixture('not-spam.eml'))).toBe('feedback_type_not_abuse');
  });

  it.each(['fraud', 'virus', 'other', 'ABUSE-ish', ''])(
    'rejects Feedback-Type %j that is not abuse',
    (type) => {
      const raw = swap(full(), 'Feedback-Type: abuse', `Feedback-Type: ${type}`);
      expect(verdict(raw)).toBe(type === '' ? 'malformed' : 'feedback_type_not_abuse');
    }
  );

  it('accepts the type in any letter case', () => {
    expect(verdict(swap(full(), 'Feedback-Type: abuse', 'feedback-type: ABUSE'))).toBe('ok');
  });
});

describe('arfReader: oversize and huge parts fail closed', () => {
  it('rejects a message over the size limit before reading it', () => {
    const padded = swap(
      full(),
      'This is an email abuse report',
      `${'A'.repeat(ARF_LIMITS.maxRawBytes)}\nThis is an email abuse report`
    );
    expect(verdict(padded)).toBe('oversized');
  });

  it('counts bytes, not characters', () => {
    const padded = swap(
      full(),
      'This is an email abuse report',
      `${'é'.repeat(ARF_LIMITS.maxRawBytes / 2 + 1)}\nThis is an email abuse report`
    );
    expect(padded.length).toBeLessThan(ARF_LIMITS.maxRawBytes);
    expect(verdict(padded)).toBe('oversized');
  });

  it('rejects an oversized feedback-report part', () => {
    const raw = swap(
      full(),
      'Source-IP: 192.0.2.77',
      `X-Pad: ${'a'.repeat(ARF_LIMITS.maxFeedbackBytes)}`
    );
    expect(verdict(raw)).toBe('malformed');
  });

  it('rejects more headers than the limit', () => {
    const many = Array.from({ length: ARF_LIMITS.maxHeaders + 1 }, (_, i) => `X-H${i}: v`).join(
      '\n'
    );
    expect(verdict(swap(full(), 'Subject: FW:', `${many}\nSubject: FW:`))).toBe('malformed');
  });

  it('rejects more parts than the limit', () => {
    const extra = Array.from(
      { length: ARF_LIMITS.maxParts },
      () => '--part-boundary-01\nContent-Type: text/plain\n\nx\n'
    ).join('');
    expect(
      verdict(
        swap(
          full(),
          '--part-boundary-01\nContent-Type: message/feedback-report',
          `${extra}--part-boundary-01\nContent-Type: message/feedback-report`
        )
      )
    ).toBe('malformed');
  });
});

describe('arfReader: malformed MIME fails closed', () => {
  it('rejects a message with no closing boundary (truncated)', () => {
    expect(verdict(swap(full(), '--part-boundary-01--', ''))).toBe('malformed');
  });

  it('rejects a message cut off inside the report part', () => {
    const raw = full();
    expect(verdict(raw.slice(0, raw.indexOf('Original-Rcpt-To')))).toBe('malformed');
  });

  it('rejects a missing, empty or illegal boundary', () => {
    expect(verdict(swap(full(), '; boundary="part-boundary-01"', ''))).toBe('malformed');
    expect(verdict(swap(full(), 'boundary="part-boundary-01"', 'boundary=""'))).toBe('malformed');
    expect(verdict(swap(full(), 'boundary="part-boundary-01"', 'boundary="bad<boundary>"'))).toBe(
      'malformed'
    );
  });

  it('rejects a NUL byte and a lone carriage return anywhere', () => {
    expect(verdict(swap(full(), 'User-Agent: ExampleFBL/1.0', 'User-Agent: Example\0FBL'))).toBe(
      'malformed'
    );
    expect(verdict(swap(full(), 'User-Agent: ExampleFBL/1.0', 'User-Agent: Example\rFBL'))).toBe(
      'malformed'
    );
  });

  it('rejects a header line that is not name: value, or has a space before the colon', () => {
    expect(verdict(swap(full(), 'Subject: A newsletter', 'Subject A newsletter'))).toBe(
      'malformed'
    );
    expect(verdict(swap(full(), 'Message-ID: ' + OURS, 'Message-ID : ' + OURS))).toBe('malformed');
  });

  it('rejects a continuation line with nothing to continue', () => {
    expect(verdict(' leading continuation\n' + full())).toBe('malformed');
  });

  it('rejects two top-level Content-Type headers and an unbalanced quote in one', () => {
    expect(
      verdict(swap(full(), 'MIME-Version: 1.0', 'MIME-Version: 1.0\nContent-Type: text/plain'))
    ).toBe('malformed');
    expect(verdict(swap(full(), 'boundary="part-boundary-01"', 'boundary="part-boundary-01'))).toBe(
      'malformed'
    );
  });

  it('rejects a report part that is encoded rather than read as sent', () => {
    expect(
      verdict(
        swap(
          full(),
          'Content-Type: message/feedback-report',
          'Content-Type: message/feedback-report\nContent-Transfer-Encoding: base64'
        )
      )
    ).toBe('malformed');
  });

  it('rejects zero, two, or ambiguous report and original parts', () => {
    const report =
      '--part-boundary-01\nContent-Type: message/feedback-report\n\nVersion: 1\nFeedback-Type: abuse\nUser-Agent: x\nOriginal-Rcpt-To: other@example.com\n\n';
    expect(
      verdict(
        swap(
          full(),
          '--part-boundary-01\nContent-Type: message/feedback-report',
          `${report}--part-boundary-01\nContent-Type: message/feedback-report`
        )
      )
    ).toBe('malformed');
    expect(
      verdict(swap(full(), 'Content-Type: message/feedback-report', 'Content-Type: text/plain'))
    ).toBe('malformed');
    expect(verdict(swap(full(), 'Content-Type: message/rfc822', 'Content-Type: text/plain'))).toBe(
      'malformed'
    );
    const original =
      '--part-boundary-01\nContent-Type: text/rfc822-headers\n\nMessage-ID: <x@y.invalid>\n\n';
    expect(
      verdict(
        swap(
          full(),
          '--part-boundary-01\nContent-Type: message/rfc822',
          `${original}--part-boundary-01\nContent-Type: message/rfc822`
        )
      )
    ).toBe('malformed');
  });

  it('rejects a second field group in the report part', () => {
    expect(
      verdict(
        swap(
          full(),
          'Reported-Domain: tenant.example',
          'Reported-Domain: tenant.example\n\nOriginal-Rcpt-To: victim@example.com'
        )
      )
    ).toBe('malformed');
  });
});

describe('arfReader: nested and injected messages fail closed', () => {
  it('rejects a quoted original that smuggles the outer boundary and a second report', () => {
    const smuggled = swap(
      full(),
      'Body of the original message that the provider quoted.',
      [
        '--part-boundary-01',
        'Content-Type: message/feedback-report',
        '',
        'Version: 1',
        'Feedback-Type: abuse',
        'User-Agent: forged',
        'Original-Rcpt-To: victim@example.com',
      ].join('\n')
    );
    expect(verdict(smuggled)).toBe('malformed');
  });

  it('reads a whole report quoted inside the original as body text, never as the report', () => {
    const inner = swap(
      full(),
      'Body of the original message that the provider quoted.',
      'Content-Type: multipart/report; report-type=feedback-report; boundary="x"\n\n--x\nContent-Type: message/feedback-report\n\nVersion: 1\nFeedback-Type: abuse\nUser-Agent: nested\nOriginal-Rcpt-To: victim@example.com\n--x--'
    );
    expect(read(inner, RECEIVED)).toMatchObject({
      ok: true,
      record: { recipient: 'reader@example.com' },
    });
  });

  it('does not take a Message-ID hidden in a folded header, nor one in the body', () => {
    const hidden = swap(
      full(),
      'Message-ID: ' + OURS,
      'Message-ID: <foreign@example.com>\nX-Note: x\n Message-ID: ' + OURS
    );
    expect(verdict(hidden)).toBe('not_ours');
  });

  it('rejects two Message-ID headers in the quoted original', () => {
    expect(
      verdict(
        swap(
          full(),
          'Subject: A newsletter',
          'Message-ID: <foreign@example.com>\nSubject: A newsletter'
        )
      )
    ).toBe('malformed');
  });
});

describe('arfReader: spoofed reports fail closed', () => {
  it('rejects a report with no Authentication-Results from our MTA', () => {
    const raw = full().split('\n').slice(1).join('\n');
    expect(verdict(raw)).toBe('unauthenticated');
  });

  it('rejects an Authentication-Results line stamped by another host', () => {
    expect(
      verdict(
        swap(
          full(),
          'Authentication-Results: mx1.collector.example;',
          'Authentication-Results: elsewhere.example;'
        )
      )
    ).toBe('unauthenticated');
  });

  it('rejects two Authentication-Results headers carrying our id', () => {
    const forged = swap(
      full(),
      'Received:',
      'Authentication-Results: mx1.collector.example; dkim=pass header.d=feedback-provider.example\nReceived:'
    );
    expect(verdict(forged)).toBe('unauthenticated');
  });

  it.each([
    ['a failed DKIM', 'dkim=fail header.d=feedback-provider.example'],
    ['a neutral DKIM', 'dkim=neutral header.d=feedback-provider.example'],
    ['a pass for another domain', 'dkim=pass header.d=attacker.example'],
    ['a pass for a look-alike prefix', 'dkim=pass header.d=evilfeedback-provider.example'],
    [
      'a pass for a look-alike suffix',
      'dkim=pass header.d=feedback-provider.example.attacker.example',
    ],
    [
      'a comment that says pass',
      'dkim=fail (dkim=pass header.d=feedback-provider.example) header.d=attacker.example',
    ],
    ['no DKIM at all', 'spf=pass smtp.mailfrom=feedback-provider.example'],
  ])('rejects %s', (_name, results) => {
    const raw = swap(
      full(),
      'dkim=pass (2048-bit key) header.d=feedback-provider.example header.i=@feedback-provider.example; spf=pass smtp.mailfrom=feedback-provider.example',
      results
    );
    expect(verdict(raw)).toBe('unauthenticated');
  });

  it('rejects an Authentication-Results with unbalanced parentheses', () => {
    expect(verdict(swap(full(), '(2048-bit key)', '(2048-bit key'))).toBe('unauthenticated');
  });

  it('rejects a From that does not align with the signing domain', () => {
    expect(verdict(swap(full(), '<fbl@feedback-provider.example>', '<fbl@attacker.example>'))).toBe(
      'unauthenticated'
    );
  });

  it('rejects a missing, repeated or listed From', () => {
    expect(
      verdict(swap(full(), 'From: "Abuse Feedback" <fbl@feedback-provider.example>\n', ''))
    ).toBe('unauthenticated');
    expect(
      verdict(
        swap(full(), 'To: complaints@', 'From: fbl@feedback-provider.example\nTo: complaints@')
      )
    ).toBe('unauthenticated');
    expect(
      verdict(
        swap(
          full(),
          '<fbl@feedback-provider.example>',
          '<fbl@feedback-provider.example>, <b@attacker.example>'
        )
      )
    ).toBe('unauthenticated');
  });

  it('rejects a recipient claimed in the report that the quoted original does not carry', () => {
    expect(
      verdict(
        swap(
          full(),
          'Original-Rcpt-To: <Reader@Example.COM>',
          'Original-Rcpt-To: victim@example.com'
        )
      )
    ).toBe('recipient_mismatch');
  });

  it('rejects a quoted To with more than one address or none readable', () => {
    expect(
      verdict(
        swap(
          full(),
          'To: "Reader, A" <reader@example.com>',
          'To: reader@example.com, victim@example.com'
        )
      )
    ).toBe('recipient_mismatch');
    expect(
      verdict(swap(full(), 'To: "Reader, A" <reader@example.com>', 'To: undisclosed-recipients:;'))
    ).toBe('recipient_mismatch');
  });

  it('rejects a message-id this collector did not mint', () => {
    expect(verdict(swap(full(), OURS, '<someone-elses@example.com>'))).toBe('not_ours');
    expect(
      verdict(
        swap(
          full(),
          OURS,
          '<4cfbf575-9efc-4508-bc4f-e0f9314e4844.0@74656e616e742d61.outcomes.invalid>'
        )
      )
    ).toBe('not_ours');
  });

  it('reads a display name with a comma as one address, not a list', () => {
    expect(verdict(full())).toBe('ok');
  });
});

describe('arfReader: missing and doubled fields fail closed', () => {
  it.each(['Version: 1\n', 'Feedback-Type: abuse\n', 'User-Agent: ExampleFBL/1.0\n'])(
    'rejects a report without %j',
    (line) => {
      const raw = headersOnlyWithout(line);
      expect(verdict(raw)).toBe('malformed');
    }
  );

  it('rejects an unknown Version and an empty User-Agent', () => {
    expect(verdict(swap(full(), '\nVersion: 1\n', '\nVersion: 2\n'))).toBe('malformed');
    expect(verdict(swap(full(), 'User-Agent: ExampleFBL/1.0', 'User-Agent:'))).toBe('malformed');
  });

  it('rejects a doubled Feedback-Type, Original-Rcpt-To or Arrival-Date', () => {
    expect(
      verdict(swap(full(), 'Feedback-Type: abuse', 'Feedback-Type: not-spam\nFeedback-Type: abuse'))
    ).toBe('malformed');
    expect(
      verdict(swap(full(), 'Source-IP:', 'Original-Rcpt-To: victim@example.com\nSource-IP:'))
    ).toBe('malformed');
    expect(
      verdict(
        swap(full(), 'Source-IP:', 'Arrival-Date: Tue, 10 Nov 2026 08:00:00 +0000\nSource-IP:')
      )
    ).toBe('malformed');
  });

  it('rejects an Original-Rcpt-To that is not a single plain address', () => {
    expect(
      verdict(
        swap(
          full(),
          'Original-Rcpt-To: <Reader@Example.COM>',
          'Original-Rcpt-To: a@example.com, b@example.com'
        )
      )
    ).toBe('malformed');
    expect(
      verdict(
        swap(full(), 'Original-Rcpt-To: <Reader@Example.COM>', 'Original-Rcpt-To: not-an-address')
      )
    ).toBe('malformed');
  });

  it('rejects a report that names no recipient anywhere, and one with no Message-ID', () => {
    const noTo = swap(
      swap(full(), 'Original-Rcpt-To: <Reader@Example.COM>\n', ''),
      'To: "Reader, A" <reader@example.com>\n',
      ''
    );
    expect(verdict(noTo)).toBe('no_recipient');
    expect(verdict(swap(full(), 'Message-ID: ' + OURS + '\n', ''))).toBe('no_message_id');
  });

  it('ignores an unreadable Arrival-Date rather than failing the report', () => {
    expect(
      read(
        swap(
          full(),
          'Arrival-Date: Tue, 10 Nov 2026 08:59:30 +0000',
          'Arrival-Date: yesterday-ish'
        ),
        RECEIVED
      )
    ).toMatchObject({ ok: true, record: { arrivalDateMs: null } });
  });
});

describe('createArfReader: an unusable configuration is refused at construction', () => {
  it('requires a host-name authserv-id, at least one source, and valid source names and domains', () => {
    const source = { name: 'ok', dkimDomains: ['feedback-provider.example'] };
    expect(() => createArfReader({ trustedAuthservId: '', sources: [source] })).toThrow(TypeError);
    expect(() => createArfReader({ trustedAuthservId: 'mx1.example', sources: [] })).toThrow(
      TypeError
    );
    expect(() =>
      createArfReader({
        trustedAuthservId: 'mx1.example',
        sources: [{ name: 'Bad Name', dkimDomains: ['a.example'] }],
      })
    ).toThrow(TypeError);
    expect(() =>
      createArfReader({
        trustedAuthservId: 'mx1.example',
        sources: [{ name: 'ok', dkimDomains: [] }],
      })
    ).toThrow(TypeError);
    expect(() =>
      createArfReader({
        trustedAuthservId: 'mx1.example',
        sources: [{ name: 'ok', dkimDomains: ['not a domain'] }],
      })
    ).toThrow(TypeError);
  });
});

/** The headers-only fixture with one required field line removed; its report part is Version, Feedback-Type, User-Agent only. */
function headersOnlyWithout(line: string): string {
  const raw = fixture('abuse-headers-only.eml').replace(
    'Version: 1\nFeedback-Type: abuse\nUser-Agent: ExampleFBL/2.0',
    'Version: 1\nFeedback-Type: abuse\nUser-Agent: ExampleFBL/1.0'
  );
  return swap(raw, line, '');
}
