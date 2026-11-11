// A local stand-in for the mail spool (the mailgun-shim image), for running the
// mail gate where the pinned image cannot be pulled (the credential-free PR job;
// registry-push runs the pinned digest). It keeps the shim's env contract and its
// three surfaces: SMTP with AUTH, a Mailgun-shaped POST, and a token-guarded
// drain. It is NOT the spool; the real shim stays the authority. It mirrors one
// control, since a key-only check passes sends the shim refuses: a credential may
// send only as its own sender domain (Mailgun 400 as messages.ts, SMTP MAIL FROM
// 553 as smtpFrontDoor.ts). Domains only, case-insensitive, no trailing dot; the
// shim's address parsing is not copied. The drain listener mirrors the shim's
// bind contract: it binds SHIM_DRAIN_HOST alone, and the stand-in refuses to
// start when SHIM_DRAIN_PORT is set with no host, never falling back to every
// interface. (The shim also refuses a hostname or a wildcard; that classifier is
// not copied, render-core's posture check owns the rendered value.) Node built-ins only.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const KEYS = process.env.SHIM_KEYS_PATH || '/data/keys.json';
const DRAIN_TOKEN = process.env.SHIM_DRAIN_TOKEN;
const DRAIN_PORT = process.env.SHIM_DRAIN_PORT;
const DRAIN_HOST = process.env.SHIM_DRAIN_HOST;
if (DRAIN_PORT && !DRAIN_HOST) {
  process.stderr.write(
    'SHIM_DRAIN_HOST is required when SHIM_DRAIN_PORT is set: the drain listener binds one address, never every interface\n'
  );
  process.exit(1);
}
const queue = [];
let nextId = 1;

// { domain: { key, senderDomain } }, written by cli.js register.
const registry = () => {
  try {
    return JSON.parse(fs.readFileSync(KEYS, 'utf8'));
  } catch {
    return {};
  }
};
const keyOf = (domain) => registry()[domain]?.key;

const normalizeDomain = (d) => d.trim().toLowerCase().replace(/\.+$/, '');

// Every mailbox in a From header: the <...> parts, else the comma-separated bare addresses.
function mailboxes(from) {
  const angled = [...from.matchAll(/<([^>]*)>/g)].map((m) => m[1]);
  return angled.length > 0 ? angled : from.split(',').map((a) => a.trim());
}

// True only when the address (or every From mailbox) is in the credential's sender domain.
function inSenderDomain(addresses, domain) {
  const senderDomain = registry()[domain]?.senderDomain;
  if (!senderDomain || addresses.length === 0) return false;
  return addresses.every((a) => {
    const at = a.lastIndexOf('@');
    return at > 0 && normalizeDomain(a.slice(at + 1)) === normalizeDomain(senderDomain);
  });
}

function enqueue(domain, from, to, subject, text, recipientVariables = {}) {
  queue.push({
    id: `m${nextId}`,
    domain,
    emailId: null,
    from,
    to,
    subject,
    html: text,
    text,
    headers: {},
    replyTo: undefined,
    recipientVariables,
    drainCount: 0,
  });
  nextId += 1;
}

function parseMultipart(body, contentType = '') {
  // indexOf, not a regex: the header is client-controlled and a regex here is polynomial.
  const at = contentType.indexOf('boundary=');
  if (at < 0) return null;
  const boundary = contentType.slice(at + 'boundary='.length);
  if (!boundary) return null;
  const fields = [];
  for (const part of body.split(`--${boundary}`)) {
    const cut = part.indexOf('\r\n\r\n');
    if (cut < 0) continue;
    const name = /name="([^"]+)"/.exec(part.slice(0, cut));
    if (name) fields.push([name[1], part.slice(cut + 4).replace(/\r\n$/, '')]);
  }
  return fields;
}

function messagesRoute(req, res, domain) {
  const auth = (req.headers.authorization || '').replace(/^Basic /, '');
  const [user, key] = Buffer.from(auth, 'base64').toString().split(':');
  if (user !== 'api' || keyOf(domain) !== key) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"message":"Forbidden"}');
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    const fields = parseMultipart(body, req.headers['content-type']);
    const bad = (message) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message }));
    };
    if (!fields) return bad('multipart body has no boundary');
    const get = (n) => fields.find(([k]) => k === n)?.[1] ?? '';
    if (!inSenderDomain(mailboxes(get('from')), domain)) {
      return bad(`'from' address must belong to the domain ${registry()[domain]?.senderDomain}`);
    }
    let vars;
    try {
      vars = JSON.parse(get('recipient-variables') || '{}');
    } catch {
      return bad('recipient-variables is not JSON');
    }
    const tos = fields.filter(([k]) => k === 'to').map(([, v]) => v);
    for (const to of tos) {
      enqueue(domain, get('from'), to, get('subject'), get('text'), vars);
      queue[queue.length - 1].html = get('html');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `<standin-${nextId}@${domain}>`, message: 'Queued. Thank you.' }));
  });
}

const httpServer = http.createServer((req, res) => {
  const m = /^\/v3\/([^/]+)\/messages$/.exec(req.url);
  if (req.method === 'GET' && req.url === '/healthz') return res.end('ok');
  if (req.method === 'POST' && m) return messagesRoute(req, res, m[1]);
  res.writeHead(404);
  res.end();
});

const drainServer = http.createServer((req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('content-type', 'text/plain');
    return res.end(`mailgun_shim_undrained_recipients ${queue.length}\n`);
  }
  if (req.headers.authorization !== `Bearer ${DRAIN_TOKEN}`) {
    res.writeHead(401);
    return res.end();
  }
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === '/drain') {
    const messages = queue.filter((r) => r.drainCount === 0).slice(0, 10);
    messages.forEach((r) => {
      r.drainCount += 1;
    });
    return res.end(
      JSON.stringify({ messages: messages.map(({ recipientVariables, ...rest }) => rest) })
    );
  }
  if (req.method === 'POST' && req.url === '/drain/ack') {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let acks;
      try {
        acks = JSON.parse(body).acks;
      } catch {
        acks = null;
      }
      if (!Array.isArray(acks)) {
        res.writeHead(400);
        return res.end('{"message":"acks is not a JSON list"}');
      }
      for (const { id, drainCount } of acks) {
        const i = queue.findIndex((r) => r.id === id && r.drainCount === drainCount);
        if (i >= 0) queue.splice(i, 1);
      }
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

function smtpSession(socket) {
  let authed = null;
  let rcpt = [];
  let from = '';
  let data = null;
  let authStep = null;
  const say = (line) => socket.write(`${line}\r\n`);
  say('220 standin ESMTP');
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (data !== null) {
        if (line === '.') {
          const head = data.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
          const subject = /^Subject: (.*)$/im.exec(head)?.[1] ?? '';
          for (const to of rcpt) enqueue(authed, from, to, subject, data);
          data = null;
          rcpt = [];
          say('250 queued');
        } else data += `${line}\r\n`;
        continue;
      }
      if (authStep) {
        const decoded = Buffer.from(line, 'base64').toString('utf8');
        if (authStep.stage === 'user') {
          authStep = { stage: 'pass', user: decoded };
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        const user = authStep.user;
        authStep = null;
        if (keyOf(user) === decoded) {
          authed = user;
          say('235 ok');
        } else say('535 bad credentials');
        continue;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO') || cmd.startsWith('HELO'))
        say('250-standin\r\n250 AUTH PLAIN LOGIN');
      else if (cmd.startsWith('AUTH PLAIN ')) {
        const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
        if (keyOf(user) === pass) {
          authed = user;
          say('235 ok');
        } else say('535 bad credentials');
      } else if (cmd === 'AUTH LOGIN') {
        authStep = { stage: 'user' };
        say('334 VXNlcm5hbWU6');
      } else if (!authed && (cmd.startsWith('MAIL') || cmd.startsWith('RCPT') || cmd === 'DATA'))
        say('530 authenticate first');
      else if (cmd.startsWith('MAIL FROM')) {
        from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        if (!inSenderDomain([from], authed)) {
          say('553 5.7.1 Sender address rejected: domain not authorised for this account');
          from = '';
        } else say('250 ok');
      } else if (cmd.startsWith('RCPT TO')) {
        rcpt.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
        say('250 ok');
      } else if (cmd === 'DATA') {
        data = '';
        say('354 go');
      } else if (cmd === 'RSET') {
        rcpt = [];
        say('250 ok');
      } else if (cmd === 'NOOP') say('250 ok');
      else if (cmd === 'QUIT') {
        say('221 bye');
        socket.end();
        return;
      } else say('502 not implemented');
    }
  });
  socket.on('error', () => {});
}

httpServer.listen(Number(process.env.PORT || 8080));
// With no drain port the legacy default stays, on loopback only.
drainServer.listen(Number(DRAIN_PORT || 8081), DRAIN_HOST || '127.0.0.1');
net.createServer(smtpSession).listen(Number(process.env.SMTP_LISTEN_PORT || 2525));
