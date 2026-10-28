import { describe, expect, it, vi } from 'vitest';

// A parser that reads the value the gate serialised (a quoted name, which the
// submitted value does not have) as a different mailbox than the submitted
// one: the read-back check must refuse rather than ship a normal form that is
// itself ambiguous. Told apart by the input, not by call order, because the
// gate reads a value more than once before it serialises it.
const parseCalls: string[] = [];
vi.mock('nodemailer/lib/addressparser/index.js', () => ({
  default: (input: string) => {
    parseCalls.push(input);
    return [
      {
        name: 'Name',
        address: input.startsWith('"') ? 'b@tenant.example.com' : 'a@tenant.example.com',
      },
    ];
  },
}));

describe('boundSender read-back', () => {
  it('refuses a value whose normal form reads back as a different mailbox', async () => {
    const { boundSender } = await import('../../src/senderAuthorization.js');
    expect(boundSender('Name <a@tenant.example.com>', 'tenant.example.com')).toBeNull();
    expect(parseCalls).toContain('"Name" <a@tenant.example.com>');
  });
});
