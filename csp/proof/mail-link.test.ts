import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeQuotedPrintable, decodedBodies, findMagicLink } from './mail-link.ts';

const ORIGIN = 'http://localhost:4321';
const LINK = `${ORIGIN}/members/?token=abc123def456&action=signup&r=http%3A%2F%2Flocalhost%3A4321%2F`;

// The way the mail library sends it: the `=` of the query is `=3D`, and a long
// line is cut with a soft break (`=` then a newline).
function quotedPrintable(text: string): string {
  return text.replace(/=/g, '=3D').replace(/(.{40})/g, '$1=\r\n');
}

function message(parts: string[]): string {
  const body = parts.map((part) => `--b1\r\n${part}`).join('\r\n');
  return `From: a@example.test\r\nSubject: Complete your sign up\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n${body}\r\n--b1--\r\n`;
}

const textPart = (text: string): string =>
  `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(text)}\r\n`;

test('a link the mail library soft-wrapped and escaped reads back whole', () => {
  const raw = message([textPart(`Click here: ${LINK}\nThanks`)]);
  assert.equal(findMagicLink(raw, ORIGIN), LINK);
});

test('a link in an HTML part has its &amp; read as &', () => {
  const html = `<a href="${LINK.replace(/&/g, '&amp;')}">Sign up</a>`;
  const raw = message([
    `Content-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(html)}\r\n`,
  ]);
  assert.equal(findMagicLink(raw, ORIGIN), LINK);
});

test('a base64 body is decoded', () => {
  const body = Buffer.from(`Open ${LINK} now`).toString('base64');
  const raw = message([
    `Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`,
  ]);
  assert.equal(findMagicLink(raw, ORIGIN), LINK);
});

test('a link on another origin is not the tenant magic link', () => {
  const raw = message([textPart('Open https://elsewhere.example/members/?token=zzz')]);
  assert.equal(findMagicLink(raw, ORIGIN), null);
});

test('a message with no link yields null, and a single-part message is read', () => {
  assert.equal(findMagicLink('Subject: hi\r\n\r\nno link here', ORIGIN), null);
  assert.equal(findMagicLink(`Subject: hi\r\n\r\n${LINK}`, ORIGIN), LINK);
});

test('quoted-printable decoding drops soft breaks and decodes escapes', () => {
  assert.equal(decodeQuotedPrintable('a=3Db=\nc'), 'a=bc');
});

test('multipart parts are each decoded', () => {
  const raw = message([textPart('one'), textPart('two')]);
  assert.deepEqual(
    decodedBodies(raw).map((body) => body.trim()),
    ['one', 'two']
  );
});
