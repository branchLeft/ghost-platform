// node --test csp/proof/smtp-sink.test.mjs -- node:test and node:net only.
// The sink is how the checkout proof gets the magic link out of a real SMTP
// conversation, so the decoding is tested against the encodings Ghost's mailer
// actually produces (quoted-printable with soft breaks, base64, multipart).
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import {
  decodeQuotedPrintable,
  extractMagicLink,
  parseMessage,
  startSmtpSink,
} from './smtp-sink.mjs';

const LINK =
  'http://localhost:4311/members/?token=abc123DEF456&action=signup&r=http%3A%2F%2Flocalhost%3A4311%2F';

function qpEncode(text) {
  // 76-column soft-wrapped quoted-printable, '=' and '&' kept literal-safe.
  return text.replace(/=/g, '=3D').replace(/(.{70})/g, '$1=\r\n');
}

async function sendMail(port, raw) {
  const socket = net.connect(port, '127.0.0.1');
  socket.setEncoding('utf-8');
  const lines = [];
  socket.on('data', (d) => lines.push(d));
  const waitFor = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (lines.join('').includes(code)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${code}; got ${lines.join('')}`);
  };
  await waitFor('220');
  socket.write('EHLO test\r\n');
  await waitFor('250 8BITMIME');
  socket.write('MAIL FROM:<a@example.test>\r\nRCPT TO:<b@example.test>\r\nDATA\r\n');
  await waitFor('354');
  socket.write(`${raw}\r\n.\r\n`);
  await waitFor('250 queued');
  socket.write('QUIT\r\n');
  await waitFor('221');
}

test('decodeQuotedPrintable joins soft breaks and decodes =XX', () => {
  assert.equal(decodeQuotedPrintable('a=3Db=\r\nc'), 'a=bc');
  assert.equal(decodeQuotedPrintable('caf=C3=A9'), 'café');
});

test('control: a body with no link yields no link', () => {
  assert.equal(extractMagicLink({ text: 'hello, nothing to see' }), null);
});

test('extractMagicLink finds a link wrapped across quoted-printable soft breaks', () => {
  const raw = [
    'To: Member <member@example.test>',
    'Subject: Complete your sign up',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    qpEncode(`Hello\r\nClick ${LINK} to continue\r\n`),
  ].join('\r\n');
  assert.equal(extractMagicLink(parseMessage(raw)), LINK);
});

test('extractMagicLink reads a base64 part and undoes &amp; in an html part', () => {
  const html = `<a href="${LINK.replace(/&/g, '&amp;')}">Sign in</a>`;
  const raw = [
    'To: member@example.test',
    'Subject: Sign in',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64'),
    '--b1--',
    '',
  ].join('\r\n');
  assert.equal(extractMagicLink(parseMessage(raw)), LINK);
});

test('the sink receives a real SMTP conversation and serves the link by recipient', async () => {
  const sink = await startSmtpSink({ host: '127.0.0.1' });
  try {
    const raw = [
      'To: member@example.test',
      'Subject: Complete your sign up',
      'Content-Type: text/plain',
      '',
      `Open ${LINK}`,
    ].join('\r\n');
    await sendMail(sink.smtpPort, raw);
    assert.equal(sink.messages.length, 1);

    const hit = await fetch(`http://127.0.0.1:${sink.httpPort}/link?to=member@example.test`);
    assert.equal(hit.status, 200);
    assert.equal((await hit.json()).link, LINK);

    const miss = await fetch(`http://127.0.0.1:${sink.httpPort}/link?to=nobody@example.test`);
    assert.equal(miss.status, 404);
  } finally {
    await sink.close();
  }
});
