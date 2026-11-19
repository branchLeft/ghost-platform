// The private key is written to its own file and to nothing else. This runs
// the real service with TLS on and every place a key could be sent to watched:
// the logger it is given, both process streams, the console, the metrics
// textfile and every other file the host end leaves behind. A refusal's error
// is checked the same way.
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { newTempDir, signHeaders, startRig } from '../helpers/verdict-host-rig.mjs';
import { tlsRequest } from '../helpers/verdict-host-tls-client.mjs';

const require = createRequire(import.meta.url);
const { ensureTlsIdentity } = require('../../verdict-host/tls-identity.js');
const { TlsIdentityError } = require('../../verdict-host/tls-identity-error.js');

const directories = [];
let rig;
afterEach(async () => {
  vi.restoreAllMocks();
  await rig?.cleanup();
  rig = undefined;
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

// Every distinctive piece of the key: each PEM body line, the whole body, and
// the raw key bytes in the two encodings they could be printed in.
function secretsIn(privateKeyPem) {
  const lines = privateKeyPem.split('\n').filter((line) => line && !line.startsWith('-----'));
  const body = lines.join('');
  const der = crypto.createPrivateKey(privateKeyPem).export({ type: 'pkcs8', format: 'der' });
  return [...lines, body, der.toString('hex'), der.toString('base64url')];
}

function expectNoSecret(label, text, secrets) {
  for (const secret of secrets) {
    expect(text.includes(secret), `${label} holds part of the private key`).toBe(false);
  }
}

function listFiles(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('the private key', () => {
  it('never reaches a log, a stream, the metrics file or any other file, through a full run', async () => {
    const written = [];
    const capture = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      vi.spyOn(console, method).mockImplementation((...args) => written.push(args.join(' ')));
    }

    const directory = newTempDir();
    rig = await startRig({
      directory,
      config: {
        tlsCertFile: path.join(directory, 'tls.crt'),
        tlsKeyFile: path.join(directory, 'tls.key'),
      },
    });
    const keyFile = path.join(directory, 'tls.key');
    const secrets = secretsIn(fs.readFileSync(keyFile, 'utf8'));
    const { port } = rig.host.inbound.address;
    await tlsRequest({
      port,
      path: '/safety/v1/pending',
      headers: signHeaders(rig.keys.privateKey, 'GET', '/safety/v1/pending', '', {
        now: rig.clock.now(),
      }),
    });
    await tlsRequest({ port, path: '/safety/v1/pending' });
    const junk = net.connect(port, '127.0.0.1');
    junk.on('error', () => {});
    await new Promise((resolve) => {
      junk.once('close', resolve);
      junk.end('not tls');
    });
    await rig.stop();

    const files = listFiles(directory).filter((file) => file !== keyFile);
    expect(files.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(['tls.crt', 'verdict_host.prom', 'queue.journal'])
    );
    for (const file of files) {
      expectNoSecret(path.basename(file), fs.readFileSync(file).toString('latin1'), secrets);
    }
    expectNoSecret('the logger', rig.lines.join('\n'), secrets);
    expectNoSecret('the process streams and console', written.join('\n'), secrets);
    expect(rig.lines.join('\n')).toContain('VERDICT_HOST_TLS_HANDSHAKE_FAILED');
    expect(JSON.stringify(Object.keys(rig.host))).not.toMatch(/key|private/i);
  });

  const scenarios = {
    'a key readable by others': ({ keyFile }) => fs.chmodSync(keyFile, 0o644),
    'an expired certificate': () => Date.UTC(2040, 0, 1),
    'a damaged key': ({ keyFile, privateKeyPem }) =>
      fs.writeFileSync(keyFile, privateKeyPem.replace(/A/g, 'B'), { mode: 0o600 }),
    'a key that is a link': ({ keyFile, certFile }) => {
      fs.rmSync(keyFile);
      fs.symlinkSync(certFile, keyFile);
    },
    'a key that is another key': ({ keyFile }) => {
      const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
      fs.writeFileSync(keyFile, other.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    },
    'a key that is the wrong kind': ({ keyFile }) => {
      const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      fs.writeFileSync(keyFile, rsa.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    },
    'a missing key': ({ keyFile }) => fs.rmSync(keyFile),
  };

  it.each(Object.keys(scenarios))('is not in the error for %s', (name) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tls-leak-'));
    directories.push(directory);
    const certFile = path.join(directory, 'tls.crt');
    const keyFile = path.join(directory, 'tls.key');
    const { privateKeyPem } = ensureTlsIdentity({ certFile, keyFile });
    const secrets = secretsIn(privateKeyPem);
    const laterNow = scenarios[name]({ certFile, keyFile, privateKeyPem });

    let refusal;
    try {
      ensureTlsIdentity({ certFile, keyFile, now: () => laterNow ?? Date.now() });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(TlsIdentityError);
    const everything = [
      refusal.message,
      refusal.stack,
      String(refusal.cause?.message),
      String(refusal.cause?.stack),
      JSON.stringify(refusal),
    ].join('\n');
    expectNoSecret(`the ${refusal.reason} refusal`, everything, secrets);
  });
});
