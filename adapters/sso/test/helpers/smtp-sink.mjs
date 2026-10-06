// A one-purpose SMTP server for tests: accepts any message, keeps it, and
// speaks only the commands a mail client needs to send one. It runs in a
// worker thread because the code under test shells out synchronously, which
// would otherwise freeze a server living in the same event loop.
import net from 'node:net';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';

function serve() {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let inData = false;
    let buffer = '';
    let current = { to: [], data: '' };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 sink ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          parentPort.postMessage({ type: 'message', message: current });
          current = { to: [], data: '' };
          reply('250 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') reply('250 sink');
        else if (verb === 'RCPT') {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
    socket.on('error', () => {});
  });
  server.listen(0, '0.0.0.0', () =>
    parentPort.postMessage({ type: 'listening', port: server.address().port })
  );
  parentPort.on('message', (msg) => {
    if (msg === 'stop') server.close(() => process.exit(0));
  });
}

if (!isMainThread) serve();

export class SmtpSink {
  messages = [];

  static async start() {
    const sink = new SmtpSink();
    sink.worker = new Worker(new URL(import.meta.url));
    sink.port = await new Promise((resolve, reject) => {
      sink.worker.on('error', reject);
      sink.worker.on('message', (msg) => {
        if (msg.type === 'listening') resolve(msg.port);
        else if (msg.type === 'message') sink.messages.push(msg.message);
      });
    });
    return sink;
  }

  async stop() {
    await this.worker.terminate();
  }
}

/**
 * The readable text of a captured message: every base64 part decoded, and the
 * rest read as quoted-printable (soft line breaks and =XX escapes).
 */
export function decodeMail(raw) {
  const parts = [];
  const rest = raw.replace(
    /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g,
    (_, body) => {
      parts.push(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8'));
      return '';
    }
  );
  const quoted = rest
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return [quoted, ...parts].join('\n');
}
