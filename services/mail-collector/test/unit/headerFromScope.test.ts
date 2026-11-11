import { describe, expect, it } from 'vitest';
import { checkHeaderFrom } from '../../src/headerFromScope.js';

const SCOPE = 'scope.example';
const message = (from: unknown, headers: Record<string, string> = {}) => ({
  from: from as string,
  headers,
});

describe('checkHeaderFrom: the header From must name exactly one mailbox in the sending domain', () => {
  describe('accepted', () => {
    it.each([
      ['a bare address', 'hello@scope.example'],
      ['an address in angle brackets', '<hello@scope.example>'],
      ['a display name and an address', 'Newsletter <hello@scope.example>'],
      ['a quoted display name holding punctuation', '"News, Letter" <hello@scope.example>'],
      ['a display name that looks like another address', '"x@main.example" <hello@scope.example>'],
      ['an upper-case domain', 'hello@SCOPE.Example'],
      ['a trailing root dot', 'hello@scope.example.'],
      ['a non-ASCII display name', 'Café <hello@scope.example>'],
      ['an encoded word in the display name', '=?utf-8?q?News?= <hello@scope.example>'],
    ])('%s', (_label, from) => {
      expect(checkHeaderFrom(message(from), SCOPE)).toEqual({ ok: true });
    });

    it('treats an internationalised domain and its punycode form as the same domain', () => {
      expect(checkHeaderFrom(message('hello@straße.example'), 'xn--strae-oqa.example')).toEqual({
        ok: true,
      });
      expect(checkHeaderFrom(message('hello@xn--strae-oqa.example'), 'straße.example')).toEqual({
        ok: true,
      });
    });

    it('compares the scope in the same normal form, whatever case the descriptor spells it in', () => {
      expect(checkHeaderFrom(message('hello@scope.example'), 'SCOPE.Example.')).toEqual({
        ok: true,
      });
    });

    it('accepts custom headers that name no sender', () => {
      expect(
        checkHeaderFrom(message('hello@scope.example', { 'X-Ghost-Email-Id': 'e1' }), SCOPE)
      ).toEqual({ ok: true });
    });
  });

  describe('out of scope', () => {
    it.each([
      ['the main domain', 'hello@main.example'],
      ['another tenant', 'hello@other-tenant.example'],
      ['a subdomain of the scope', 'hello@news.scope.example'],
      ['a parent of the scope', 'hello@example'],
      ['a domain that only ends like the scope', 'hello@notscope.example'],
      ['a domain that only starts like the scope', 'hello@scope.example.evil.test'],
      ['the scope as a display name only', '"hello@scope.example" <hello@main.example>'],
      ['the scope as an unquoted display name only', 'hello@scope.example <hello@main.example>'],
      ['a space inside the domain', '<a@scope .example>'],
    ])('%s', (_label, from) => {
      expect(checkHeaderFrom(message(from), SCOPE)).toEqual({
        ok: false,
        reason: 'from-out-of-scope',
      });
    });
  });

  describe('unreadable, so refused', () => {
    it.each([
      ['a missing From', undefined],
      ['a null From', null],
      ['a number', 42],
      ['an empty From', ''],
      ['a blank From', '   '],
      ['a name with no address', 'Newsletter'],
      ['an address with no domain', 'hello@'],
      ['an address with no local part', '@scope.example'],
      ['an address with no @', 'hello.scope.example'],
      ['two mailboxes, both in scope', 'a@scope.example, b@scope.example'],
      ['two mailboxes, one in scope', 'a@scope.example, b@main.example'],
      ['two mailboxes, the in-scope one last', 'b@main.example, a@scope.example'],
      ['group syntax naming one in-scope mailbox', 'Team: a@scope.example;'],
      ['group syntax naming two mailboxes', 'Team: a@scope.example, b@main.example;'],
      ['an empty group', 'Team:;'],
      ['a line break and a second line', 'a@scope.example\r\nBcc: b@main.example'],
      ['a bare line feed', 'a@scope.example\nb@main.example'],
      ['a NUL byte', 'a@scope.example\u0000'],
      ['a second @ in the address', '<x@main.example@scope.example>'],
      ['a quoted @ in the local part', '"x@main.example"@scope.example'],
      ['a space in the local part', '"a b"@scope.example'],
      ['an encoded word in the address', '<=?utf-8?q?x?=@scope.example>'],
      ['a domain with a character a hostname cannot hold', 'a@scope.example>'],
      ['a value over the line limit', `${'a'.repeat(1000)}@scope.example`],
    ])('%s', (_label, from) => {
      expect(checkHeaderFrom(message(from), SCOPE)).toEqual({
        ok: false,
        reason: 'from-unreadable',
      });
    });

    it.each([
      'Sender',
      'sender',
      'SENDER',
      'From',
      'from',
      'Return-Path',
      'return-path',
      'Resent-From',
      'Resent-Sender',
    ])('a competing identity header (%s) is refused even when the From is in scope', (name) => {
      expect(
        checkHeaderFrom(message('hello@scope.example', { [name]: 'x@scope.example' }), SCOPE)
      ).toEqual({ ok: false, reason: 'from-unreadable' });
    });

    it.each([
      'Sender ',
      ' Sender',
      'sender\r\n',
      'SENDER\t',
      'Return-Path\r\n',
      ' return-path ',
      'Resent-From\r',
      '\tRESENT-FROM',
      'Resent-Sender \r\n',
    ])(
      'a competing identity header whose key is padded or has a line break (%j) is refused',
      (name) => {
        expect(
          checkHeaderFrom(message('hello@scope.example', { [name]: 'x@scope.example' }), SCOPE)
        ).toEqual({ ok: false, reason: 'from-unreadable' });
      }
    );

    it('does not read a message with no headers object as carrying one', () => {
      expect(checkHeaderFrom({ from: 'hello@scope.example' } as never, SCOPE)).toEqual({
        ok: true,
      });
    });
  });

  describe('no scope to compare against', () => {
    it.each([
      ['no sending domain', undefined],
      ['an empty sending domain', ''],
      ['a sending domain of dots', '...'],
      ['a sending domain that is not a hostname', 'scope example'],
      ['a sending domain that is an address', 'hello@scope.example'],
    ])('%s', (_label, scope) => {
      expect(checkHeaderFrom(message('hello@scope.example'), scope)).toEqual({
        ok: false,
        reason: 'from-scope-unknown',
      });
    });
  });

  it('never puts an address, a name or a domain in a verdict', () => {
    const verdict = checkHeaderFrom(message('"Secret Name" <leak@main.example>'), SCOPE);
    expect(JSON.stringify(verdict)).not.toMatch(/Secret|leak|main\.example|scope\.example/);
  });
});
