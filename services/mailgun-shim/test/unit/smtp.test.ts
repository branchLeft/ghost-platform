import nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { isSafeRecipientAddress, sendToRecipient, type Transporter } from '../../src/smtp.js';

function mockTransport(sendMailImpl?: (options: unknown) => Promise<unknown>): {
  transport: Transporter;
  sendMail: ReturnType<typeof vi.fn>;
} {
  const sendMail = vi.fn(sendMailImpl ?? (async () => ({})));
  return { transport: { sendMail } as unknown as Transporter, sendMail };
}

const BASE_PARAMS = {
  from: 'TENANT_1 <noreply@tenant1.example.com>',
  to: 'member@example.com',
  subject: 'Hello',
  html: '<p>hi</p>',
  text: 'hi',
  domain: 'tenant1.example.com',
  extraHeaders: {},
};

describe('sendToRecipient — message construction', () => {
  it('sends to the plain address when no toName is given', async () => {
    const { transport, sendMail } = mockTransport();
    await sendToRecipient(transport, BASE_PARAMS);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const options = sendMail.mock.calls[0]![0] as { to: unknown };
    expect(options.to).toBe('member@example.com');
  });

  it('sends to a {name, address} object when toName is given, batched to this one recipient only', async () => {
    const { transport, sendMail } = mockTransport();
    await sendToRecipient(transport, { ...BASE_PARAMS, toName: 'Member One' });
    const options = sendMail.mock.calls[0]![0] as { to: unknown };
    expect(options.to).toEqual({ name: 'Member One', address: 'member@example.com' });
  });

  it('carries from/subject/html/text through unchanged (personalisation is resolved by the caller)', async () => {
    const { transport, sendMail } = mockTransport();
    await sendToRecipient(transport, {
      ...BASE_PARAMS,
      subject: 'Hello Member One',
      html: '<p>Hi Member One</p>',
      text: 'Hi Member One',
    });
    const options = sendMail.mock.calls[0]![0] as {
      from: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(options.from).toBe(BASE_PARAMS.from);
    expect(options.subject).toBe('Hello Member One');
    expect(options.html).toBe('<p>Hi Member One</p>');
    expect(options.text).toBe('Hi Member One');
  });

  it('sets the X-Ghost-Email-Id header when an emailId is provided', async () => {
    const { transport, sendMail } = mockTransport();
    await sendToRecipient(transport, { ...BASE_PARAMS, emailId: 'email-record-42' });
    const options = sendMail.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(options.headers['X-Ghost-Email-Id']).toBe('email-record-42');
  });

  it('omits the X-Ghost-Email-Id header when no emailId is provided', async () => {
    const { transport, sendMail } = mockTransport();
    await sendToRecipient(transport, BASE_PARAMS);
    const options = sendMail.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(options.headers['X-Ghost-Email-Id']).toBeUndefined();
  });

  it('merges extraHeaders alongside the correlation header', async () => {
    const { transport, sendMail } = mockTransport();
    await sendToRecipient(transport, {
      ...BASE_PARAMS,
      emailId: 'email-record-42',
      extraHeaders: { 'List-Unsubscribe': '<https://example.com/unsub>' },
    });
    const options = sendMail.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(options.headers['List-Unsubscribe']).toBe('<https://example.com/unsub>');
    expect(options.headers['X-Ghost-Email-Id']).toBe('email-record-42');
  });

  it('generates a distinct provider message id per call, scoped to the domain', async () => {
    const { transport } = mockTransport();
    const first = await sendToRecipient(transport, BASE_PARAMS);
    const second = await sendToRecipient(transport, BASE_PARAMS);
    expect(first.providerMessageId).not.toBe(second.providerMessageId);
    expect(first.providerMessageId).toContain('@tenant1.example.com');
  });

  it('maps h:Reply-To to the SMTP replyTo field', async () => {
    const { transport, sendMail } = mockTransport();
    await sendToRecipient(transport, {
      ...BASE_PARAMS,
      replyTo: 'replies@tenant1.example.com',
    });
    const options = sendMail.mock.calls[0]![0] as { replyTo: string };
    expect(options.replyTo).toBe('replies@tenant1.example.com');
  });

  it('returns ok:true with the provider message id on a successful send', async () => {
    const { transport } = mockTransport();
    const result = await sendToRecipient(transport, BASE_PARAMS);
    expect(result).toMatchObject({ ok: true, recipient: 'member@example.com' });
    expect(result.providerMessageId).toBeTruthy();
  });

  it('returns ok:false with the SMTP error code/message on a rejected send, without throwing', async () => {
    const { transport } = mockTransport(async () => {
      const err = new Error('mailbox unavailable') as Error & { responseCode: number };
      err.responseCode = 550;
      throw err;
    });
    const result = await sendToRecipient(transport, BASE_PARAMS);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(550);
    expect(result.errorMessage).toBe('mailbox unavailable');
  });

  it('truncates an overlong error message to 2000 characters', async () => {
    const { transport } = mockTransport(async () => {
      throw new Error('x'.repeat(3000));
    });
    const result = await sendToRecipient(transport, BASE_PARAMS);
    expect(result.errorMessage).toHaveLength(2000);
  });
});

describe('isSafeRecipientAddress', () => {
  it.each(['member@example.com', 'first.last+tag@example.co.uk', 'a@b.co'])(
    'accepts plain address %s',
    (address) => {
      expect(isSafeRecipientAddress(address)).toBe(true);
    }
  );

  it.each([
    ['no-at-sign', 'no @ at all'],
    ['@no-local-part.com', 'empty local part'],
    ['no-domain@', 'empty domain'],
    ['two@ats@example.com', 'more than one @'],
    ['', 'empty string'],
    ['victim@example.com\r\nRCPT TO:<attacker@evil.com>', 'CRLF injection attempt'],
    ['grp:attacker@evil.com;', 'RFC 2822 group syntax via colon/semicolon'],
    ['a@example.com,b@evil.com', 'comma address-list injection'],
    ['"quoted"@example.com', 'quote characters'],
    ['<angle@example.com>', 'angle brackets'],
    ['tab\tinjected@example.com', 'embedded tab'],
  ])('rejects %s (%s)', (address) => {
    expect(isSafeRecipientAddress(address)).toBe(false);
  });
});

describe('sendToRecipient — recipient-hijack fix', () => {
  it('a colon-bearing recipient (RFC 2822 group syntax) is rejected before nodemailer ever sees it', async () => {
    const { transport, sendMail } = mockTransport();
    const result = await sendToRecipient(transport, {
      ...BASE_PARAMS,
      to: 'grp:attacker@evil.com;',
    });
    expect(sendMail).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.recipient).toBe('grp:attacker@evil.com;');
  });

  it('a CRLF-bearing recipient is rejected before nodemailer ever sees it', async () => {
    const { transport, sendMail } = mockTransport();
    const result = await sendToRecipient(transport, {
      ...BASE_PARAMS,
      to: 'victim@example.com\r\nRCPT TO:<attacker@evil.com>',
    });
    expect(sendMail).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe('header-injection resistance in the real composed message (no network — nodemailer streamTransport)', () => {
  // Wraps the real (in-process, no socket) streamTransport so sendToRecipient's
  // own header/subject construction runs unmodified, while still letting the
  // test inspect the raw RFC 822 bytes nodemailer actually composed.
  function capturingRealTransport(): { transport: Transporter; raw(): string } {
    const real = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let composed: { message: Buffer } | undefined;
    const transport = {
      sendMail: async (options: unknown) => {
        composed = (await real.sendMail(options as never)) as { message: Buffer };
        return composed;
      },
    } as unknown as Transporter;
    return {
      transport,
      raw() {
        if (!composed) {
          throw new Error('sendMail was never called');
        }
        return composed.message.toString();
      },
    };
  }

  it('a CRLF in the subject cannot smuggle an extra header line into the raw composed message', async () => {
    const { transport, raw } = capturingRealTransport();
    const result = await sendToRecipient(transport, {
      ...BASE_PARAMS,
      subject: 'Hello\r\nX-Injected: pwned\r\nBcc: attacker@evil.com',
    });
    expect(result.ok).toBe(true);

    const message = raw();
    const headerBlock = message.slice(0, message.indexOf('\r\n\r\n'));
    expect(headerBlock).not.toMatch(/^X-Injected:/m);
    expect(headerBlock).not.toMatch(/^Bcc:/m);
    // Exactly one Subject: line — the injected content is folded into it as
    // plain text, not split into new header lines.
    expect(headerBlock.match(/^Subject:/gm)).toHaveLength(1);
  });

  it('a CRLF in an extraHeaders value (e.g. a resolved List-Unsubscribe) cannot smuggle an extra header line', async () => {
    const { transport, raw } = capturingRealTransport();
    await sendToRecipient(transport, {
      ...BASE_PARAMS,
      extraHeaders: { 'List-Unsubscribe': '<https://example.com/a>\r\nX-Injected: pwned' },
    });

    const message = raw();
    const headerBlock = message.slice(0, message.indexOf('\r\n\r\n'));
    expect(headerBlock).not.toMatch(/^X-Injected:/m);
  });
});
