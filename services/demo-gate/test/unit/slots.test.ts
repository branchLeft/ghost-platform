import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashIdOf, validateSlotName } from '@branchleft/ghost-platform-render-core';
import {
  createLeaseReader,
  createSlotsSource,
  parseSlots,
  SlotsFormatError,
} from '../../src/slots.js';

const HASH =
  '$argon2id$v=19$m=8192,t=1,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFndGFndGFndGFndGFndGFndGFndGFndGE';
const HASH_ID = hashIdOf(HASH);
const LEASE = '01J9F4Q7ZC3M8V2K6X0R5T1B9D';
const entry = (over: Record<string, unknown> = {}) => ({
  host: 'a1b2.demo.example',
  slot: '0',
  gate: { kind: 'passphrase', argon2idHash: HASH },
  ...over,
});
const file = (...slots: unknown[]) => JSON.stringify({ slots });

describe('parseSlots', () => {
  it('maps each host to its slot and parsed hash', () => {
    const slots = parseSlots(file(entry(), entry({ host: 'c3d4.demo.example', slot: '1' })));
    expect(slots.get('a1b2.demo.example')?.slot).toBe('0');
    expect(slots.get('c3d4.demo.example')?.hash.memoryKiB).toBe(8192);
    expect(slots.size).toBe(2);
  });

  it("carries the raw PHC string's hashId alongside the parsed hash", () => {
    const slots = parseSlots(file(entry()));
    expect(slots.get('a1b2.demo.example')?.hashId).toBe(HASH_ID);
  });

  it('accepts an empty slot list', () => {
    expect(parseSlots(file()).size).toBe(0);
  });

  it.each([
    ['invalid JSON', '{'],
    ['no slots array', '{}'],
    ['null', 'null'],
    ['a non-object entry', file('x')],
    ['a null entry', file(null)],
    ['an unknown key', file(entry({ extra: 1 }))],
    ['an uppercase host', file(entry({ host: 'A.demo.example' }))],
    ['a single-label host', file(entry({ host: 'localhost' }))],
    ['a host with a port', file(entry({ host: 'a.demo.example:443' }))],
    ['a bad slot', file(entry({ slot: '../0' }))],
    ['a duplicate host', file(entry(), entry({ slot: '1' }))],
    ['a duplicate slot', file(entry(), entry({ host: 'x.demo.example' }))],
    ['an ungated slot', file(entry({ gate: { kind: 'none' } }))],
    ['a gate that is not an object', file(entry({ gate: 'passphrase' }))],
    [
      'a gate with extra keys',
      file(entry({ gate: { kind: 'passphrase', argon2idHash: HASH, p: 1 } })),
    ],
    [
      'a clear-text passphrase',
      file(entry({ gate: { kind: 'passphrase', argon2idHash: 'demo-pass-1234' } })),
    ],
  ])('refuses the whole file for %s', (_label, text) => {
    expect(() => parseSlots(text)).toThrow(SlotsFormatError);
  });
});

describe('files on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-gate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('re-reads the slots file on every call and reflects a change at once', async () => {
    const path = join(dir, 'slots.json');
    writeFileSync(path, file(entry()));
    const source = createSlotsSource(path);
    const first = await source();
    expect(await source()).toBe(first);
    writeFileSync(path, file(entry({ host: 'new.demo.example' })));
    expect((await source()).has('new.demo.example')).toBe(true);
    expect((await source()).has('a1b2.demo.example')).toBe(false);
  });

  it('throws on a slots file that turned malformed, or too large, or vanished', async () => {
    const path = join(dir, 'slots.json');
    writeFileSync(path, file(entry()));
    const source = createSlotsSource(path);
    await source();
    writeFileSync(path, '{');
    await expect(source()).rejects.toThrow(SlotsFormatError);
    writeFileSync(path, ' '.repeat(256 * 1024 + 1));
    await expect(source()).rejects.toThrow(/too large/);
    rmSync(path);
    await expect(source()).rejects.toThrow();
  });

  it('reads the current lease and hashId from the broker record', async () => {
    writeFileSync(
      join(dir, '0.json'),
      JSON.stringify({ slot: '0', lease: LEASE, hashId: HASH_ID })
    );
    expect(await createLeaseReader(dir)(validateSlotName('0'))).toEqual({
      lease: LEASE,
      hashId: HASH_ID,
    });
  });

  it('throws on a missing, malformed, misplaced or symlinked record', async () => {
    const read = createLeaseReader(dir);
    await expect(read(validateSlotName('0'))).rejects.toThrow();
    writeFileSync(join(dir, '0.json'), 'nope');
    await expect(read(validateSlotName('0'))).rejects.toThrow();
    writeFileSync(
      join(dir, '1.json'),
      JSON.stringify({ slot: '0', lease: LEASE, hashId: HASH_ID })
    );
    await expect(read(validateSlotName('1'))).rejects.toThrow(/names slot/);
    writeFileSync(
      join(dir, 'real.json'),
      JSON.stringify({ slot: '2', lease: LEASE, hashId: HASH_ID })
    );
    symlinkSync(join(dir, 'real.json'), join(dir, '2.json'));
    await expect(read(validateSlotName('2'))).rejects.toThrow();
  });

  it('throws on a lease record missing hashId (an old-shape record the broker must never write)', async () => {
    writeFileSync(join(dir, '0.json'), JSON.stringify({ slot: '0', lease: LEASE }));
    await expect(createLeaseReader(dir)(validateSlotName('0'))).rejects.toThrow(/hashId/);
  });
});
