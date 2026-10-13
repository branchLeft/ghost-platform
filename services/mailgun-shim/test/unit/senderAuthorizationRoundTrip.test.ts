import { describe, expect, it, vi } from 'vitest';

// A parser whose second reading of the value the gate serialised names a
// different mailbox than its first: the read-back check must refuse rather
// than ship a normal form that is itself ambiguous.
const parseCalls: string[] = [];
vi.mock('nodemailer/lib/addressparser/index.js', () => ({
  default: (input: string) => {
    parseCalls.push(input);
    return parseCalls.length === 1
      ? [{ name: 'Name', address: 'a@tenant.example.com' }]
      : [{ name: 'Name', address: 'b@tenant.example.com' }];
  },
}));

describe('boundSender read-back', () => {
  it('refuses a value whose normal form reads back as a different mailbox', async () => {
    const { boundSender } = await import('../../src/senderAuthorization.js');
    expect(boundSender('Name <a@tenant.example.com>', 'tenant.example.com')).toBeNull();
    expect(parseCalls).toHaveLength(2);
  });
});
