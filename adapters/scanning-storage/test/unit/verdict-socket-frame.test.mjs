import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const frame = require('../../src/verdict-socket-frame');

const goodKey = Buffer.alloc(32, 7).toString('base64');

describe('isPdqKey', () => {
  it('accepts the canonical base64 of exactly 32 bytes', () => {
    expect(frame.isPdqKey(goodKey)).toBe(true);
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['too short', Buffer.alloc(31, 7).toString('base64')],
    ['too long', Buffer.alloc(33, 7).toString('base64')],
    ['a path', '/etc/passwd'],
    ['padding changed', goodKey.replace(/=$/, 'A')],
    ['url-safe alphabet', Buffer.alloc(32, 255).toString('base64url') + '='],
    ['trailing newline', `${goodKey}\n`],
  ])('refuses %s', (_name, value) => {
    expect(frame.isPdqKey(value)).toBe(false);
  });
});

describe('encoding', () => {
  it('ends every line with a newline and carries the version', () => {
    expect(JSON.parse(frame.encodeAsk(goodKey))).toEqual({ v: 1, op: 'ask', key: goodKey });
    expect(frame.encodeAsk(goodKey).endsWith('\n')).toBe(true);
  });

  it('omits matchType unless it is given', () => {
    const without = JSON.parse(frame.encodeReply({ key: goodKey, classification: 'csam' }));
    const withType = JSON.parse(
      frame.encodeReply({ key: goodKey, classification: 'csam', matchType: 'near' })
    );
    expect('matchType' in without).toBe(false);
    expect(withType.matchType).toBe('near');
  });

  it('encodes an error as a versioned line with a reason', () => {
    expect(JSON.parse(frame.encodeError('busy'))).toEqual({ v: 1, error: 'busy' });
  });
});

describe('readLine', () => {
  it('resolves with the first line', async () => {
    const socket = new PassThrough();
    const reading = frame.readLine(socket, { timeoutMs: 500 });
    socket.write('{"a":1}\nignored');
    await expect(reading).resolves.toBe('{"a":1}');
  });

  it('joins a line split across chunks', async () => {
    const socket = new PassThrough();
    const reading = frame.readLine(socket, { timeoutMs: 500 });
    socket.write('{"a"');
    socket.write(':1}\n');
    await expect(reading).resolves.toBe('{"a":1}');
  });

  it('rejects a line over the limit with no newline yet', async () => {
    const socket = new PassThrough();
    const reading = frame.readLine(socket, { maxBytes: 8, timeoutMs: 500 });
    socket.write('123456789');
    await expect(reading).rejects.toThrow('line too long');
  });

  it('rejects a long line that arrives with its newline in one chunk', async () => {
    const socket = new PassThrough();
    const reading = frame.readLine(socket, { maxBytes: 8, timeoutMs: 500 });
    socket.write('123456789\n');
    await expect(reading).rejects.toThrow('line too long');
  });

  it('rejects when the socket ends first', async () => {
    const socket = new PassThrough();
    const reading = frame.readLine(socket, { timeoutMs: 500 });
    socket.end('no newline');
    await expect(reading).rejects.toThrow('closed before a full line');
  });

  it('rejects on a socket error', async () => {
    const socket = new PassThrough();
    const reading = frame.readLine(socket, { timeoutMs: 500 });
    socket.destroy(new Error('boom'));
    await expect(reading).rejects.toThrow('boom');
  });

  it('rejects on timeout and detaches its listeners', async () => {
    const socket = new PassThrough();
    await expect(frame.readLine(socket, { timeoutMs: 20 })).rejects.toThrow('timed out');
    expect(socket.listenerCount('data')).toBe(0);
  });

  it('waits without a timeout when none is given', async () => {
    const socket = new PassThrough();
    const reading = frame.readLine(socket, {});
    socket.write('x\n');
    await expect(reading).resolves.toBe('x');
  });
});

describe('parseJsonObject', () => {
  it('reads an object and refuses everything else', () => {
    expect(frame.parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(frame.parseJsonObject('[1]')).toBeNull();
    expect(frame.parseJsonObject('null')).toBeNull();
    expect(frame.parseJsonObject('{nope')).toBeNull();
  });
});
