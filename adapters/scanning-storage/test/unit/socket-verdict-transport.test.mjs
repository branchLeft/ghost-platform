import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hashOf, newTempDir } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const { createSocketVerdictTransport } = require('../../src/socket-verdict-transport');

let directory;
let server;
afterEach(() => {
  server?.close();
  server = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

// A stand-in host end that answers each connection with whatever the test says.
async function stub(onLine) {
  directory = newTempDir();
  const socketPath = path.join(directory, 's.sock');
  server = net.createServer((socket) => {
    socket.on('error', () => {});
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) onLine(socket, JSON.parse(text.split('\n')[0]));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

describe('construction', () => {
  it('needs an absolute socket path and a positive reply timeout', () => {
    expect(() => createSocketVerdictTransport({})).toThrow('absolute socketPath');
    expect(() => createSocketVerdictTransport({ socketPath: 'x.sock' })).toThrow('absolute');
    expect(() =>
      createSocketVerdictTransport({ socketPath: '/tmp/x.sock', replyTimeoutMs: 0 })
    ).toThrow('replyTimeoutMs');
  });

  it('can only name a local path, never a host and port', () => {
    expect(() => createSocketVerdictTransport({ socketPath: 'example.com:443' })).toThrow(
      'absolute'
    );
    expect(() => createSocketVerdictTransport({ socketPath: 'tcp://10.0.0.1:80' })).toThrow(
      'absolute'
    );
  });
});

describe('connecting', () => {
  it('rejects when nothing listens on the socket', async () => {
    directory = newTempDir();
    const transport = createSocketVerdictTransport({
      socketPath: path.join(directory, 'none.sock'),
    });
    await expect(transport.connect({})).rejects.toThrow();
  });

  it('rejects at once for a signal that is already aborted, and destroys a connect that is aborted', async () => {
    const socketPath = await stub(() => {});
    const transport = createSocketVerdictTransport({ socketPath });
    const aborted = new AbortController();
    aborted.abort();
    await expect(transport.connect({ signal: aborted.signal })).rejects.toThrow('aborted');

    const midway = new AbortController();
    let created;
    const slow = createSocketVerdictTransport({
      socketPath,
      connectSocket: () => {
        created = new net.Socket();
        return created;
      },
    });
    const connecting = slow.connect({ signal: midway.signal });
    midway.abort();
    await expect(connecting).rejects.toThrow('aborted');
    expect(created.destroyed).toBe(true);
  });
});

describe('asking', () => {
  it('returns the host end reply exactly as it came, with its own key', async () => {
    const socketPath = await stub((socket, ask) => {
      socket.write(`{"v":1,"key":"${ask.key}","classification":"csam","matchType":"exact"}\n`);
    });
    const connection = await createSocketVerdictTransport({ socketPath }).connect({});
    expect(await connection.ask(hashOf(1))).toEqual({
      v: 1,
      key: hashOf(1),
      classification: 'csam',
      matchType: 'exact',
    });
    connection.close();
  });

  it('does not stamp the asked key onto a reply that names another', async () => {
    const socketPath = await stub((socket) => {
      socket.write(`{"v":1,"key":"${hashOf(9)}","classification":"no-known-match"}\n`);
    });
    const connection = await createSocketVerdictTransport({ socketPath }).connect({});
    expect((await connection.ask(hashOf(1))).key).toBe(hashOf(9));
    connection.close();
  });

  it('allows one ask per connection', async () => {
    const socketPath = await stub((socket) =>
      socket.write('{"v":1,"key":"k","classification":"x"}\n')
    );
    const connection = await createSocketVerdictTransport({ socketPath }).connect({});
    await connection.ask(hashOf(1));
    await expect(connection.ask(hashOf(2))).rejects.toThrow('one ask per connection');
    connection.close();
  });

  it.each([
    ['an error line', '{"v":1,"error":"busy"}\n', 'refused the ask: busy'],
    ['a line that is not JSON', 'nope\n', 'unreadable reply'],
    ['a reply of another version', '{"v":2,"key":"k"}\n', 'unreadable reply'],
  ])('rejects on %s', async (_name, line, message) => {
    const socketPath = await stub((socket) => socket.write(line));
    const connection = await createSocketVerdictTransport({ socketPath }).connect({});
    await expect(connection.ask(hashOf(1))).rejects.toThrow(message);
    connection.close();
  });

  it('rejects when the host end is silent past the reply timeout', async () => {
    const socketPath = await stub(() => {});
    const connection = await createSocketVerdictTransport({
      socketPath,
      replyTimeoutMs: 40,
    }).connect({});
    await expect(connection.ask(hashOf(1))).rejects.toThrow('timed out');
    connection.close();
  });

  it('rejects when told to stop, before and during the ask', async () => {
    const socketPath = await stub(() => {});
    const transport = createSocketVerdictTransport({ socketPath });
    const before = await transport.connect({});
    const aborted = new AbortController();
    aborted.abort();
    await expect(before.ask(hashOf(1), { signal: aborted.signal })).rejects.toThrow('aborted');
    before.close();

    const during = await transport.connect({});
    const controller = new AbortController();
    const asking = during.ask(hashOf(1), { signal: controller.signal });
    controller.abort();
    await expect(asking).rejects.toThrow();
  });
});
