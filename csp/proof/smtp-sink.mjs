#!/usr/bin/env node
// A dependency-free SMTP receiver for the checkout proof (node:net and
// node:http only, so it needs no install and no lockfile entry). Ghost sends
// its sign-in email here; the proof reads the magic link back out of it.
//
// Why not services/mail-collector/docker-proof/smtp-sink: that one requires
// AUTH and records only the subject and recipient, so it cannot yield the link.
//
// SMTP on SMTP_PORT (no AUTH, no STARTTLS), and a read-only HTTP view on
// HTTP_PORT: GET /messages (all, as JSON) and GET /link?to=<address> (the
// newest magic link addressed to that recipient, or 404).
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

/** Decodes quoted-printable: soft line breaks, then =XX octets (as UTF-8). */
export function decodeQuotedPrintable(text) {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined[i], 'utf-8'));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

function header(raw, name) {
  const headerBlock = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const match = headerBlock.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'));
  return match ? match[1].trim() : '';
}

function splitHeadBody(raw) {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match) return [raw, ''];
  return [raw.slice(0, match.index), raw.slice(match.index + match[0].length)];
}

/** The decoded text of every leaf part of a (possibly multipart) message. */
function leafText(raw) {
  const [head, body] = splitHeadBody(raw);
  const flat = head.replace(/\r?\n[ \t]+/g, ' ');
  const boundary = (flat.match(/^Content-Type:[^\n]*boundary="?([^";\r\n]+)"?/im) || [])[1];
  if (boundary) {
    return body
      .split(`--${boundary}`)
      .slice(1)
      .filter((part) => !part.startsWith('--'))
      .map((part) => leafText(part.replace(/^\r?\n/, '')))
      .join('\n');
  }
  const encoding = (
    (flat.match(/^Content-Transfer-Encoding:[ \t]*(\S+)/im) || [])[1] || ''
  ).toLowerCase();
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  if (encoding === 'base64')
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
  return body;
}

/** Parses a raw RFC 5322 message into the fields the proof reads. */
export function parseMessage(raw) {
  return { to: header(raw, 'To'), subject: header(raw, 'Subject'), text: leafText(raw) };
}

/** The first Ghost magic link in a parsed message, with `&amp;` undone, or null. */
export function extractMagicLink(message) {
  const urls = message.text.match(/https?:\/\/[^\s"'<>]+\/members\/\?token=[^\s"'<>]+/g) || [];
  return urls.length ? urls[0].replace(/&amp;/g, '&') : null;
}

/**
 * Starts the sink. `smtpPort`/`httpPort` 0 picks free ports. Resolves to
 * `{ smtpPort, httpPort, messages, close }`.
 */
export async function startSmtpSink({ smtpPort = 0, httpPort = 0, host = '0.0.0.0' } = {}) {
  const messages = [];

  const smtp = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    let dataBuffer = '';
    socket.setEncoding('utf-8');
    socket.write('220 csp-proof-sink ESMTP\r\n');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) {
            // Keep the unterminated tail; the terminator may straddle chunks.
            return;
          }
          dataBuffer = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          // Undo SMTP dot-stuffing.
          const raw = dataBuffer.replace(/^\.\./gm, '.');
          messages.push({ receivedAt: new Date().toISOString(), ...parseMessage(raw) });
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-csp-proof-sink\r\n250 8BITMIME\r\n');
        else if (verb === 'HELO') socket.write('250 csp-proof-sink\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP')
          socket.write('250 ok\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else socket.write('502 not implemented\r\n');
      }
    });
  });

  const view = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://sink');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/messages') {
      res.end(JSON.stringify(messages));
    } else if (url.pathname === '/link') {
      const to = (url.searchParams.get('to') || '').toLowerCase();
      const match = [...messages]
        .reverse()
        .find((m) => m.to.toLowerCase().includes(to) && extractMagicLink(m));
      if (!match) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'no magic link for that recipient yet' }));
      } else {
        res.end(JSON.stringify({ link: extractMagicLink(match), subject: match.subject }));
      }
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });

  await new Promise((resolve) => smtp.listen(smtpPort, host, resolve));
  await new Promise((resolve) => view.listen(httpPort, host, resolve));

  return {
    smtpPort: smtp.address().port,
    httpPort: view.address().port,
    messages,
    close: () =>
      Promise.all([
        new Promise((resolve) => smtp.close(resolve)),
        new Promise((resolve) => view.close(resolve)),
      ]),
  };
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const sink = await startSmtpSink({
    smtpPort: Number(process.env.SINK_SMTP_PORT || 2525),
    httpPort: Number(process.env.SINK_HTTP_PORT || 2526),
  });
  console.log(`smtp-sink: smtp=${sink.smtpPort} http=${sink.httpPort}`);
}
