#!/usr/bin/env node
// Differential for the sender gate: sender text that some address parsers read
// as a different domain than the gate did. See encodedWordDifferential.md.
//
//   node test/differential/encodedWordDifferential.mjs [--seed N] [--size N]
//        [--concurrency N] [--control] [--json]
//
// Needs dist/ built (`npm run build`). Not run by `npm run test:unit`.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const TENANT = 'tenant-a.example.com';
const FOREIGN = 'other.example';

// ---------------------------------------------------------------- arguments

function argValue(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}
const SEED = argValue('--seed', 1);
const SIZE = argValue('--size', 6000);
const CONCURRENCY = argValue('--concurrency', 8);
const CONTROL = process.argv.includes('--control');
const AS_JSON = process.argv.includes('--json');
// Print this many disagreeing values (submitted and queued) to stderr, for local diagnosis.
const SHOW = argValue('--show', 0);
let shown = 0;

// ------------------------------------------------------------------- corpus

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];

const CHARSETS = ['utf-8', 'UTF-8', 'iso-8859-1', 'US-ASCII', 'Utf-8'];
const LOCALS = ['alice', 'NAME_PLACEHOLDER', 'a.b', 'x'];
const SPECIALS = ['@', '.', '<', '>', ':', ';', ',', '"', '(', ')', '\\', ' '];
const SEPARATORS = ['', ' ', '\r\n ', '\t'];

function qBody(rng, bytes) {
  const mode = pick(rng, ['specials', 'all', 'mixedhex']);
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    const plain = /[A-Za-z0-9]/.test(ch);
    if (byte === 0x20 && mode !== 'all') {
      out += rng() < 0.5 ? '_' : '=20';
    } else if (plain && mode !== 'all') {
      out += ch;
    } else if ((ch === '.' || ch === '-') && mode === 'specials') {
      out += ch;
    } else {
      const hex = byte.toString(16).padStart(2, '0');
      out += '=' + (mode === 'mixedhex' && rng() < 0.5 ? hex : hex.toUpperCase());
    }
  }
  return out;
}

/** One encoded word that decodes to `text`, in a random charset, encoding and case. */
function word(rng, text) {
  const bytes = Buffer.from(text, 'utf8');
  const useB = rng() < 0.5;
  const marker = useB ? pick(rng, ['b', 'B']) : pick(rng, ['q', 'Q']);
  const body = useB ? bytes.toString('base64') : qBody(rng, bytes);
  return `=?${pick(rng, CHARSETS)}?${marker}?${body}?=`;
}
/** A word whose text carries the characters literally, not encoded. */
function rawWord(rng, text) {
  return `=?${pick(rng, CHARSETS)}?${pick(rng, ['q', 'Q'])}?${text}?=`;
}
/** Several adjacent words, one per part. */
function words(rng, parts) {
  return parts.map((part) => word(rng, part)).join(pick(rng, SEPARATORS));
}
/** Each `=` and `?` written as a quoted-pair, so the submitted text holds neither delimiter literally. */
const escapeDelimiters = (text) => text.replace(/[=?]/g, (ch) => `\\${ch}`);
/** A fold (CRLF then a space) placed after a word or inside one. */
function fold(rng, value) {
  if (rng() < 0.5) {
    return value.replace('?=', '?=\r\n ');
  }
  const open = value.indexOf('=?');
  const mid = value.indexOf('?', open + 5);
  return mid === -1 ? value : `${value.slice(0, mid - 1)}\r\n ${value.slice(mid - 1)}`;
}

const TEMPLATES = [
  // local part
  { p: 'local part', f: (r) => `${word(r, pick(r, LOCALS))}@${TENANT}` },
  { p: 'local part', f: (r) => `<${word(r, pick(r, LOCALS))}@${TENANT}>` },
  { p: 'local part', f: (r) => `NAME_PLACEHOLDER <${word(r, pick(r, LOCALS))}@${TENANT}>` },
  { p: 'local part', f: (r) => `"${word(r, pick(r, LOCALS))}"@${TENANT}` },
  { p: 'local part', f: (r) => `${word(r, `alice${pick(r, SPECIALS)}${FOREIGN}`)}@${TENANT}` },
  { p: 'local part', f: (r) => `${word(r, `alice@${FOREIGN}`)}@${TENANT}` },
  { p: 'local part', f: (r) => `<${word(r, `alice@${FOREIGN}`)}@${TENANT}>` },
  { p: 'local part', f: (r) => `alice${word(r, pick(r, SPECIALS))}${FOREIGN}@${TENANT}` },
  { p: 'local part', f: (r) => `${words(r, ['alice', '@', FOREIGN])}@${TENANT}` },
  { p: 'local part', f: (r) => `${words(r, ['alice', pick(r, SPECIALS), 'x'])}@${TENANT}` },
  { p: 'local part', f: (r) => `${word(r, `a<bob@${FOREIGN}>`)}@${TENANT}` },
  { p: 'local part', f: (r) => `"${word(r, 'a b')}"@${TENANT}` },
  { p: 'local part', f: (r) => `${rawWord(r, `alice${pick(r, SPECIALS)}x`)}@${TENANT}` },
  { p: 'local part', f: (r) => `<${rawWord(r, `a<bob@${FOREIGN}>`)}@${TENANT}>` },
  { p: 'local part', f: (r) => `${word(r, 'alice').slice(0, -2)}@${TENANT}` },
  // domain
  { p: 'domain', f: (r) => `alice@${word(r, TENANT)}` },
  { p: 'domain', f: (r) => `<alice@${word(r, TENANT)}>` },
  { p: 'domain', f: (r) => `alice@${word(r, FOREIGN)}` },
  { p: 'domain', f: (r) => `alice@${TENANT}${word(r, pick(r, SPECIALS))}${FOREIGN}` },
  { p: 'domain', f: (r) => `alice@${word(r, pick(r, SPECIALS) + FOREIGN)}` },
  { p: 'domain', f: (r) => `alice@${words(r, ['tenant-a', '.', 'example', '.', 'com'])}` },
  { p: 'domain', f: (r) => `alice@${TENANT}?=` },
  { p: 'domain', f: (r) => `alice@${TENANT}=?` },
  // whole address token
  { p: 'address token', f: (r) => word(r, `alice@${TENANT}`) },
  { p: 'address token', f: (r) => `<${word(r, `alice@${TENANT}`)}>` },
  { p: 'address token', f: (r) => `NAME_PLACEHOLDER <${word(r, `alice@${TENANT}`)}>` },
  { p: 'address token', f: (r) => word(r, `alice@${FOREIGN}`) },
  { p: 'address token', f: (r) => `${word(r, 'alice')}@${word(r, TENANT)}` },
  { p: 'address token', f: (r) => `${word(r, 'alice')}${word(r, '@')}${word(r, TENANT)}` },
  { p: 'address token', f: (r) => `${word(r, 'alice')}${pick(r, SEPARATORS)}@${TENANT}` },
  // group name
  {
    p: 'group name',
    f: (r) =>
      `${word(r, pick(r, ['G', `a@${FOREIGN}`, `<bob@${FOREIGN}>`, ':']))}: alice@${TENANT};`,
  },
  { p: 'group name', f: (r) => `"${word(r, 'G')}": alice@${TENANT};` },
  { p: 'group name', f: (r) => `${word(r, `G${pick(r, SPECIALS)}`)} alice@${TENANT};` },
  { p: 'group name', f: (r) => `GROUP: alice@${TENANT}, ${word(r, 'bob')}@${TENANT};` },
  { p: 'group name', f: (r) => `${rawWord(r, `G${pick(r, SPECIALS)}`)}: alice@${TENANT};` },
  // quoted string and comment
  {
    p: 'quoted string',
    f: (r) => `"${word(r, pick(r, ['Bob', `bob@${FOREIGN}`, 'Bob <bob@x>']))}" <alice@${TENANT}>`,
  },
  { p: 'quoted string', f: (r) => `"NAME_PLACEHOLDER ${word(r, 'x')}" <alice@${TENANT}>` },
  { p: 'quoted string', f: (r) => `"${word(r, 'x')}\\" <bob@${FOREIGN}>" <alice@${TENANT}>` },
  { p: 'comment', f: (r) => `alice@${TENANT} (${word(r, pick(r, ['x', `)<bob@${FOREIGN}>(`]))})` },
  { p: 'comment', f: (r) => `alice(${word(r, 'x')})@${TENANT}` },
  { p: 'comment', f: (r) => `alice@(${word(r, 'x')})${TENANT}` },
  { p: 'comment', f: (r) => `(${word(r, `bob@${FOREIGN}`)})alice@${TENANT}` },
  // display name
  {
    p: 'display name',
    f: (r) =>
      `${word(r, pick(r, ['Bob', `bob@${FOREIGN}`, `Bob <bob@${FOREIGN}>`, `x"<bob@${FOREIGN}>`, 'Ünïcode']))} <alice@${TENANT}>`,
  },
  {
    p: 'display name',
    f: (r) => `NAME_PLACEHOLDER ${word(r, pick(r, SPECIALS))} <alice@${TENANT}>`,
  },
  {
    p: 'display name',
    f: (r) => `${rawWord(r, pick(r, ['x<y', `bob@${FOREIGN}`, 'x:y']))} <alice@${TENANT}>`,
  },
  // two mailboxes
  { p: 'second mailbox', f: (r) => `alice@${TENANT}, ${word(r, `bob@${FOREIGN}`)}` },
  { p: 'second mailbox', f: (r) => `alice@${TENANT}, ${word(r, 'bob')}@${TENANT}` },
  // delimiters written as quoted-pairs (the parser unquotes them)
  {
    p: 'escaped delimiter',
    f: (r) => `"${escapeDelimiters(word(r, pick(r, LOCALS)))}"@${TENANT}`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `<"${escapeDelimiters(word(r, pick(r, LOCALS)))}"@${TENANT}>`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `NAME_PLACEHOLDER <"${escapeDelimiters(word(r, pick(r, LOCALS)))}"@${TENANT}>`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `"${escapeDelimiters(word(r, `alice@${FOREIGN}`))}"@${TENANT}`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `<"${escapeDelimiters(word(r, `alice${pick(r, SPECIALS)}${FOREIGN}`))}"@${TENANT}>`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `alice@${TENANT}, "${escapeDelimiters(word(r, `bob@${FOREIGN}`))}"@${TENANT}`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `"${escapeDelimiters(word(r, pick(r, ['G', `a@${FOREIGN}`])))}": alice@${TENANT};`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `${escapeDelimiters(word(r, 'G'))}: alice@${TENANT};`,
  },
  {
    p: 'escaped delimiter',
    f: (r) => `"${escapeDelimiters(word(r, 'x'))}", alice@${TENANT}`,
  },
  {
    p: 'escaped delimiter',
    f: (r) =>
      `"${pick(r, ['\\=\\?x', 'x\\?\\=', 'x\\=\\?y', 'x?\\=', '=\\?x', 'x\\=?y'])}"@${TENANT}`,
  },
  {
    p: 'escaped delimiter',
    f: (r) =>
      `<"${pick(r, ['\\=\\?x', 'x\\?\\=', 'x\\=\\?y', 'x?\\=', '=\\?x', 'x\\=?y'])}"@${TENANT}>`,
  },
  // folded
  { p: 'folded', f: (r) => fold(r, `${word(r, `alice@${FOREIGN}`)}@${TENANT}`) },
  { p: 'folded', f: (r) => fold(r, `NAME_PLACEHOLDER <${word(r, 'alice')}@${TENANT}>`) },
  { p: 'folded', f: (r) => fold(r, `${word(r, 'G')}: alice@${TENANT};`) },
  { p: 'folded', f: (r) => fold(r, `${words(r, ['alice', '@', FOREIGN])}@${TENANT}`) },
  // controls: no encoded word in an address token
  { p: 'control', f: () => `NAME_PLACEHOLDER <alice@${TENANT}>` },
  { p: 'control', f: () => `"NAME_PLACEHOLDER" <alice@${TENANT}>` },
  { p: 'control', f: () => `Ünïcode <alice@${TENANT}>` },
  { p: 'control', f: () => `alice@${TENANT}` },
  { p: 'control', f: (r) => `=?utf-8?q?alice <alice@${TENANT}>` },
  { p: 'control', f: () => `a=?b@${TENANT}` },
  { p: 'control', f: () => `"a\\?b"@${TENANT}` },
  {
    p: 'control',
    f: (r) => `"${escapeDelimiters(word(r, 'NAME_PLACEHOLDER'))}" <alice@${TENANT}>`,
  },
  { p: 'control', f: (r) => `${word(r, 'NAME_PLACEHOLDER')} <alice@${TENANT}>` },
];

/** The corpus: a deterministic list of { position, value }, regenerated from the seed. */
function buildCorpus(seed, size) {
  const rng = makeRng(seed);
  const seen = new Set();
  const corpus = [];
  for (let attempt = 0; corpus.length < size && attempt < size * 20; attempt++) {
    const template = TEMPLATES[attempt % TEMPLATES.length];
    const value = template.f(rng);
    if (!seen.has(value)) {
      seen.add(value);
      corpus.push({ position: template.p, value });
    }
  }
  return corpus;
}

// ------------------------------------------------------------- the real routes

const distDir = join(projectRoot, 'dist');
if (!existsSync(join(distDir, 'smtpFrontDoor.js'))) {
  console.error('dist/ is not built: run `npm run build` in services/mailgun-shim first.');
  process.exit(2);
}
const load = (name) => import(pathToFileURL(join(distDir, name)).href);
const { createMessagesRouter } = await load('routes/messages.js');
const { createSqliteStore } = await load('store.js');
const { createDrainWake } = await load('drainWake.js');
const { createLogger } = await load('log.js');
const { createSmtpFrontDoor, DEFAULT_ALLOWED_SOURCE_CIDRS } = await load('smtpFrontDoor.js');

const HTTP_PER_TENANT = 50;

function rawSmtp(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const replies = [];
    let buffer = '';
    let step = 0;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\r\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line === '' || /^\d{3}-/.test(line)) continue;
        replies.push(line);
        if (step < lines.length) {
          socket.write(lines[step++] + '\r\n');
        } else {
          socket.end();
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(replies));
    socket.connect(port, '127.0.0.1');
  });
}

async function runPool(count, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < count) {
        const index = next++;
        await work(index);
      }
    })
  );
}

/** Submits every value to one route; returns Map(index -> queued `from`) for the ones queued. */
async function submitAll(corpus, route, store, ctx) {
  const accepted = new Set();
  const subset = corpus
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => route !== 'smtp-envelope' || /^[^\s<>"\\\r\n]+$/.test(entry.value));
  await runPool(subset.length, async (n) => {
    const { value, index } = subset[n];
    const to = `r${index}@example.com`;
    if (route === 'http') {
      const form = new FormData();
      for (const [name, field] of [
        ['to', to],
        ['from', value],
        ['subject', 'Hi'],
        ['text', 'PLACEHOLDER'],
        ['recipient-variables', '{}'],
      ]) {
        form.append(name, field);
      }
      const tenant = `c${Math.floor(index / HTTP_PER_TENANT)}.example.com`;
      const res = await fetch(`${ctx.baseUrl}/v3/${tenant}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`api:key-${tenant}`).toString('base64')}` },
        body: form,
      });
      await res.arrayBuffer();
      if (res.status === 200) accepted.add(index);
      return;
    }
    const auth = Buffer.from(`\u0000${ctx.smtpUser}\u0000${ctx.smtpKey}`).toString('base64');
    const envelope = route === 'smtp-envelope' ? value : `noreply@${TENANT}`;
    const header = route === 'smtp-envelope' ? '' : `From: ${value}\r\n`;
    const replies = await rawSmtp(ctx.smtpPort, [
      'EHLO test',
      `AUTH PLAIN ${auth}`,
      `MAIL FROM:<${envelope}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      `${header}To: ${to}\r\nSubject: Hi\r\n\r\nPLACEHOLDER\r\n.`,
      'QUIT',
    ]).catch(() => []);
    if (replies.some((line) => /^250 .*Queued/.test(line))) accepted.add(index);
  });
  const queued = new Map();
  for (const row of store.claimForDrain(Date.now() / 1000 + 10, 30, 1_000_000)) {
    const index = Number(/^r(\d+)@/.exec(row.recipient)?.[1]);
    if (accepted.has(index)) queued.set(index, row.payload.from);
  }
  return { queued, attempted: subset.length };
}

// ------------------------------------------------------------------ the readers

const composer = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: 'windows',
});

/** Composes as the mail collector does and returns the raw message. */
async function compose(from) {
  const info = await composer.sendMail({
    from,
    to: 'member@example.com',
    subject: 'Hi',
    text: 'PLACEHOLDER',
  });
  return info.message;
}

const domainOf = (address) =>
  address
    .slice(address.lastIndexOf('@') + 1)
    .toLowerCase()
    .replace(/\.+$/, '');

function flattenMailparser(value) {
  return value.flatMap((entry) => (entry.group ? flattenMailparser(entry.group) : [entry]));
}

async function readMailparser(raw) {
  const parsed = await simpleParser(raw);
  const entries = flattenMailparser(parsed.from?.value ?? []);
  return entries.map((entry) =>
    (entry.address ?? '').includes('@') ? domainOf(entry.address) : ''
  );
}

function readPython(raws) {
  const python = spawnSync('python3', [join(here, 'encodedWordReader.py')], {
    input: JSON.stringify(raws.map((raw) => raw.toString('base64'))),
    maxBuffer: 1 << 28,
    encoding: 'utf8',
  });
  if (python.status !== 0) {
    throw new Error(`python3 reader failed: ${python.stderr || python.error}`);
  }
  return JSON.parse(python.stdout);
}

/** A disagreement: nothing was read, or a domain other than the tenant's. */
const disagrees = (domains) =>
  !Array.isArray(domains) || domains.length === 0 || domains.some((domain) => domain !== TENANT);

// -------------------------------------------------------------------------- run

if (spawnSync('python3', ['--version']).status !== 0) {
  console.log('SKIPPED: python3 is not available, so the Python readers cannot run.');
  process.exit(0);
}

const corpus = buildCorpus(SEED, SIZE);
const generatorSha = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(join(here, 'encodedWordReader.py')))
  .digest('hex');

const store = createSqliteStore(':memory:');
const log = createLogger(() => {});
for (let k = 0; k <= Math.floor(corpus.length / HTTP_PER_TENANT); k++) {
  store.registerTenant(`c${k}.example.com`, `key-c${k}.example.com`, TENANT);
}
const app = express();
app.use(createMessagesRouter(store, createDrainWake(), log));
const httpServer = await new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const frontDoor = createSmtpFrontDoor({
  store,
  wake: createDrainWake(),
  log,
  maxMessageBytes: 1024 * 1024,
  maxRecipientsPerMessage: 50,
  maxUnauthenticatedConnectionsPerSource: 1000,
  maxUnauthenticatedConnections: 1000,
  maxUnauthenticatedPerSourceWaitQueueDepth: 1000,
  maxUnauthenticatedPerSourceWaitMs: 10_000,
  authDeadlineMs: 10_000,
  maxConcurrentDataPhases: 1000,
  maxConcurrentDataPhasesPerSubmitter: 1000,
  allowedSourceCidrs: DEFAULT_ALLOWED_SOURCE_CIDRS,
  submitterMessagesPerMinute: 1_000_000,
});
const ctx = {
  baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
  smtpPort: await frontDoor.listen(0, '127.0.0.1'),
  smtpUser: 'c0.example.com',
  smtpKey: 'key-c0.example.com',
};

const READERS = ['mailparser', 'python policy.default', 'python getaddresses', 'python parseaddr'];
const report = {
  seed: SEED,
  corpusSize: corpus.length,
  generatorSha256: generatorSha,
  mailparserVersion: JSON.parse(
    readFileSync(join(projectRoot, 'node_modules/mailparser/package.json'), 'utf8')
  ).version,
  nodemailerVersion: JSON.parse(
    readFileSync(join(projectRoot, 'node_modules/nodemailer/package.json'), 'utf8')
  ).version,
  routes: {},
};

for (const route of ['http', 'smtp-header', 'smtp-envelope']) {
  const { queued, attempted } = await submitAll(
    corpus,
    route === 'http' ? 'http' : route,
    store,
    ctx
  );
  const indexes = [...queued.keys()];
  const raws = [];
  for (const index of indexes) raws.push(await compose(queued.get(index)));
  const pythonReads = indexes.length > 0 ? readPython(raws) : [];
  const counts = Object.fromEntries(READERS.map((reader) => [reader, 0]));
  const byPosition = {};
  for (let n = 0; n < indexes.length; n++) {
    const reads = [
      await readMailparser(raws[n]),
      pythonReads[n].default,
      pythonReads[n].getaddresses,
      pythonReads[n].parseaddr,
    ];
    const position = corpus[indexes[n]].position;
    byPosition[position] ??= { accepted: 0, disagreeing: 0 };
    byPosition[position].accepted++;
    let any = false;
    reads.forEach((domains, at) => {
      if (disagrees(domains)) {
        counts[READERS[at]]++;
        any = true;
      }
    });
    if (any) {
      byPosition[position].disagreeing++;
      if (SHOW > 0 && shown++ < SHOW) {
        console.error(
          route,
          JSON.stringify(corpus[indexes[n]].value),
          '->',
          JSON.stringify(queued.get(indexes[n]))
        );
      }
    }
  }
  report.routes[route] = { attempted, accepted: indexes.length, disagreements: counts, byPosition };
}

await frontDoor.close();
await new Promise((resolve) => httpServer.close(() => resolve()));
store.close();

const total = Object.values(report.routes)
  .flatMap((route) => Object.values(route.disagreements))
  .reduce((sum, count) => sum + count, 0);
report.totalDisagreements = total;
console.log(AS_JSON ? JSON.stringify(report, null, 2) : formatReport(report));

function formatReport(r) {
  const lines = [
    `corpus: ${r.corpusSize} values, seed ${r.seed}, generator sha256 ${r.generatorSha256.slice(0, 16)}`,
    `readers: mailparser ${r.mailparserVersion}, nodemailer ${r.nodemailerVersion}, python3 stdlib`,
  ];
  for (const [route, data] of Object.entries(r.routes)) {
    lines.push(`${route}: attempted ${data.attempted}, accepted ${data.accepted}`);
    for (const [reader, count] of Object.entries(data.disagreements)) {
      lines.push(`  ${reader}: ${count} disagreeing`);
    }
    for (const [position, c] of Object.entries(data.byPosition)) {
      lines.push(`    ${position}: accepted ${c.accepted}, disagreeing ${c.disagreeing}`);
    }
  }
  lines.push(`total disagreements: ${r.totalDisagreements}`);
  return lines.join('\n');
}

// A control run (the gate sabotaged, or the base gate) must show disagreement,
// or the zero proves nothing: it exits 0 only when disagreement was found.
process.exit(CONTROL ? (total > 0 ? 0 : 1) : total === 0 ? 0 : 1);
