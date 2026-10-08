// A dependency-free SMTP listener standing in for mx1, for the local proof only.
// It speaks just enough SMTP for Zitadel's notification channel: greeting, EHLO
// with AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, QUIT. It never relays anything.
//
// Behaviour is read from the file /state/mode on every connection, so a test
// can change it between sends:
//   ok      accept and record the message (the default)
//   stall   accept the connection and never speak: a mail host that hangs
//   refuse  answer the greeting with 421 and close: a mail host that refuses
// Every connection and every accepted message is appended to /state/sink.ndjson
// as one JSON line. A message line carries the authenticated user, the
// envelope, the Subject and the body, which the proof reads back; the
// password is checked and never written down.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const USER = process.env.SINK_SMTP_USER ?? '';
const PASS_FILE = '/state/sink-password';
// Read per authentication, so a test can rotate the password without a restart.
const pass = () =>
  existsSync(PASS_FILE)
    ? readFileSync(PASS_FILE, 'utf8').trim()
    : (process.env.SINK_SMTP_PASS ?? '');
const PORT = Number(process.env.SINK_PORT ?? 2525);
const LOG = '/state/sink.ndjson';

const mode = () => (existsSync('/state/mode') ? readFileSync('/state/mode', 'utf8').trim() : 'ok');
const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const header = (raw, name) =>
  new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(raw.split(/\r?\n\r?\n/)[0])?.[1]?.trim();

createServer((socket) => {
  const current = mode();
  log({ event: 'connection', mode: current });
  socket.on('error', () => {});
  if (current === 'stall') return;
  if (current === 'refuse') {
    socket.end('421 4.3.2 service not available\r\n');
    return;
  }
  const state = { authed: null, from: null, to: [], data: null, buffer: '', login: null };
  const say = (line) => socket.write(`${line}\r\n`);
  say('220 sink ESMTP');
  socket.on('data', (chunk) => {
    state.buffer += chunk.toString('latin1');
    for (;;) {
      if (state.data !== null) {
        const end = state.buffer.indexOf('\r\n.\r\n');
        if (end === -1) return;
        const raw = state.buffer.slice(0, end);
        state.buffer = state.buffer.slice(end + 5);
        state.data = null;
        log({
          event: 'message',
          authedAs: state.authed,
          from: state.from,
          to: state.to,
          subject: header(raw, 'Subject'),
          body: raw
            .split(/\r?\n\r?\n/)
            .slice(1)
            .join('\n\n'),
        });
        say('250 2.0.0 queued');
        continue;
      }
      const eol = state.buffer.indexOf('\r\n');
      if (eol === -1) return;
      const line = state.buffer.slice(0, eol);
      state.buffer = state.buffer.slice(eol + 2);
      const verb = line.split(' ')[0].toUpperCase();
      if (state.login === 'user') {
        state.login = { user: Buffer.from(line, 'base64').toString() };
        say('334 UGFzc3dvcmQ6');
      } else if (state.login && typeof state.login === 'object') {
        const ok = state.login.user === USER && Buffer.from(line, 'base64').toString() === pass();
        state.login = null;
        if (ok) state.authed = USER;
        say(ok ? '235 2.7.0 authenticated' : '535 5.7.8 bad credentials');
      } else if (verb === 'EHLO' || verb === 'HELO') {
        socket.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      } else if (verb === 'AUTH') {
        const [, kind, initial] = line.split(' ');
        if (kind?.toUpperCase() === 'PLAIN' && initial) {
          const [, user, given] = Buffer.from(initial, 'base64').toString().split('\0');
          const ok = user === USER && given === pass();
          if (ok) state.authed = USER;
          say(ok ? '235 2.7.0 authenticated' : '535 5.7.8 bad credentials');
        } else if (kind?.toUpperCase() === 'LOGIN') {
          state.login = 'user';
          say('334 VXNlcm5hbWU6');
        } else {
          say('504 5.5.4 unsupported');
        }
      } else if (verb === 'MAIL') {
        if (!state.authed) {
          say('530 5.7.0 authentication required');
        } else {
          state.from = /<([^>]*)>/.exec(line)?.[1] ?? null;
          say('250 2.1.0 ok');
        }
      } else if (verb === 'RCPT') {
        state.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        say('250 2.1.5 ok');
      } else if (verb === 'DATA') {
        state.data = '';
        say('354 end with <CRLF>.<CRLF>');
      } else if (verb === 'QUIT') {
        socket.end('221 2.0.0 bye\r\n');
        return;
      } else {
        say('250 2.0.0 ok');
      }
    }
  });
}).listen(PORT, '0.0.0.0');
