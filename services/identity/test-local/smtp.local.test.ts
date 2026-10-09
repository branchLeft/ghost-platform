import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';
import { desiredState } from '../src/desired.js';
import { managementClient } from '../src/management.js';
import { reconcile } from '../src/reconcile.js';
import { readSmtpPassword } from '../src/smtp.js';
import { instanceUrl } from './signin.js';

const tokenFile = process.env['ZITADEL_TOKEN_FILE'] ?? '';
const stateDir = process.env['PROOF_STATE_DIR'] ?? '';
const smtpUser = process.env['PROOF_SMTP_USER'] ?? '';
const initialPassword = process.env['PROOF_SMTP_PASSWORD'] ?? '';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sinkLog = join(stateDir, 'sink.ndjson');
const sinkPort = Number(process.env['PROOF_SINK_PORT'] ?? 12525);

const config = validateConfig({
  hostnames: {
    console: 'console.proof.test',
    portal: 'portal.proof.test',
    identity: 'id.proof.test',
  },
  tenants: [],
  // `localhost` is what Zitadel calls the sink container (compose.yml). The
  // plaintext setting is accepted only for a single-label host like this.
  smtp: { host: 'localhost', port: 2525, tls: false, senderAddress: smtpUser, senderName: 'PROOF' },
});

const client = managementClient({
  baseUrl: instanceUrl,
  token: () => readFileSync(tokenFile, 'utf8').trim(),
  fetch: (target, init) => fetch(target, init),
});

const secretsDir = mkdtempSync(join(tmpdir(), 'proof-smtp-'));
function passwordFile(value: string): string {
  const path = join(secretsDir, 'smtp-password');
  writeFileSync(path, `${value}\n`);
  chmodSync(path, 0o600);
  return path;
}
const apply = () =>
  reconcile(client, desiredState(config), {
    smtpPassword: readSmtpPassword(join(secretsDir, 'smtp-password')),
  });

interface SinkEntry {
  at: number;
  event: string;
  mode?: string;
  authedAs?: string | null;
  from?: string | null;
  to?: string[];
  subject?: string;
  body?: string;
}
const sinkEntries = (): SinkEntry[] =>
  existsSync(sinkLog)
    ? readFileSync(sinkLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SinkEntry)
    : [];
/** The sink reads the file on each connection; the pause lets a shared-folder
 * mount (Docker Desktop) show it to the container before the next request. */
const setMode = async (mode: string): Promise<void> => {
  writeFileSync(join(stateDir, 'mode'), mode);
  await sleep(1000);
};

async function until<T>(what: string, limitMs: number, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(250);
  }
}

async function adminApi(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${instanceUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

let counter = 0;
/** Asks Zitadel to send an address a verification code, and says how long its
 * answer took. Nothing here waits for the mail. */
async function requestCode(): Promise<{ address: string; ms: number; answeredAt: number }> {
  counter += 1;
  const name = `smtp-probe-${Date.now()}-${counter}`;
  const address = `${name}@recipient.test`;
  const started = Date.now();
  await adminApi('/v2/users/human', {
    username: name,
    profile: { givenName: 'PROOF', familyName: 'USER' },
    email: { email: address, sendCode: {} },
  });
  const answeredAt = Date.now();
  return { address, ms: answeredAt - started, answeredAt };
}

const delivered = (address: string): SinkEntry | undefined =>
  sinkEntries().find((entry) => entry.event === 'message' && entry.to?.includes(address));

beforeAll(async () => {
  expect(stateDir).not.toBe('');
  await setMode('ok');
  passwordFile(initialPassword);
});

describe('the sign-in service sending mail through the configured provider', () => {
  it('configures it, and a second run changes nothing', async () => {
    const first = await apply();
    expect(first.actions.find((a) => a.kind === 'smtp')?.status).toBe('created');
    const second = await apply();
    expect(second.actions.every((a) => a.status === 'unchanged')).toBe(true);
    const listed = await client.listSmtp();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ active: true, tls: false, host: 'localhost:2525' });
    expect(JSON.stringify(listed)).not.toContain(initialPassword);
  });

  it('delivers a verification code, authenticated as the sender and sent as the sender', async () => {
    const { address } = await requestCode();
    const message = await until('the code email', 45000, () => delivered(address));
    expect(message.authedAs).toBe(smtpUser);
    expect(message.from).toBe(smtpUser);
    expect(message.to).toEqual([address]);
    expect(message.subject?.length).toBeGreaterThan(0);
    expect(message.body?.length).toBeGreaterThan(0);
  });

  it('applies a rotated password: the old one stops working and the new one delivers', async () => {
    const rotated = `rotated-${Date.now()}`;
    writeFileSync(join(stateDir, 'sink-password'), rotated);
    // The mail host now refuses the old password, as it would after rotation.
    const before = await requestCode();
    await sleep(8000);
    expect(delivered(before.address)).toBeUndefined();

    passwordFile(rotated);
    const result = await apply();
    expect(result.actions.find((a) => a.kind === 'smtp')?.status).toBe('updated');
    expect(await client.listSmtp()).toHaveLength(1);
    expect((await apply()).actions.every((a) => a.status === 'unchanged')).toBe(true);

    // Zitadel picks the new provider up after a short delay; retry until it does.
    let sent: SinkEntry | undefined;
    for (let attempt = 0; attempt < 8 && sent === undefined; attempt += 1) {
      const { address } = await requestCode();
      sent = await until('a delivery or a pause', 6000, () => delivered(address)).catch(
        () => undefined
      );
    }
    expect(sent?.authedAs).toBe(smtpUser);
  });
});

describe('mail sending happens on a background queue, not inside the request', () => {
  it('control: the stalled mail host really does hold a client that waits on its greeting', async () => {
    await setMode('stall');
    const outcome = await new Promise<'greeted' | 'held'>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: sinkPort });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve('held');
      }, 4000);
      socket.on('data', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve('greeted');
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve('greeted');
      });
    });
    await setMode('ok');
    // Held for the whole 4s, so any request that waited on this host would
    // take at least that long. The assertions below use a 5s ceiling.
    expect(outcome).toBe('held');
    expect(sinkEntries().some((e) => e.event === 'connection' && e.mode === 'stall')).toBe(true);
  });

  it('answers within a few seconds while the mail host hangs, and connects afterwards', async () => {
    await setMode('ok');
    const healthy = (await requestCode()).ms;
    await setMode('stall');
    const stalled = await requestCode();
    const connection = await until('the stalled connection', 20000, () =>
      sinkEntries().find((entry) => entry.event === 'connection' && entry.mode === 'stall')
    );
    await setMode('ok');
    // A request that sent the mail inline would have waited out the hang.
    expect(stalled.ms).toBeLessThan(5000);
    expect(stalled.ms).toBeLessThan(healthy + 3000);
    expect(connection.at).toBeGreaterThan(0);
    expect(delivered(stalled.address)).toBeUndefined();
  });

  it('answers just as fast while the mail host refuses', async () => {
    await setMode('refuse');
    const refused = await requestCode();
    await setMode('ok');
    expect(refused.ms).toBeLessThan(5000);
  });
});
