import { describe, expect, it } from 'vitest';
import { PendingLoginSealer } from '../src/shell/pendingLogin.js';
import { SpentLogins } from '../src/shell/sessions.js';

const LOGIN = { verifier: 'VERIFIER-abc_123', state: 'STATE-xyz_789', expiresAt: 1000 };

describe('a sealed pending sign-in', () => {
  it('opens to what was sealed, while it is live', () => {
    const sealer = new PendingLoginSealer();
    const sealed = sealer.seal(LOGIN);
    expect(sealer.open(sealed, 999)).toEqual(LOGIN);
  });

  it('shows neither the verifier nor the state, and differs on every seal', () => {
    const sealer = new PendingLoginSealer();
    const first = sealer.seal(LOGIN);
    expect(first).not.toContain(LOGIN.verifier);
    expect(first).not.toContain(Buffer.from(LOGIN.verifier).toString('hex'));
    expect(first).not.toContain(LOGIN.state);
    expect(sealer.seal(LOGIN)).not.toBe(first);
  });

  it('is refused at and after its expiry', () => {
    const sealer = new PendingLoginSealer();
    const sealed = sealer.seal(LOGIN);
    expect(sealer.open(sealed, 1000)).toBeNull();
    expect(sealer.open(sealed, 1001)).toBeNull();
  });

  it('is refused when any part of it has been changed', () => {
    const sealer = new PendingLoginSealer();
    const sealed = sealer.seal(LOGIN);
    for (const at of [0, 12 * 2, 28 * 2, sealed.length - 2]) {
      const digit = sealed[at] === '0' ? '1' : '0';
      const altered = `${sealed.slice(0, at)}${digit}${sealed.slice(at + 1)}`;
      expect(sealer.open(altered, 0)).toBeNull();
    }
    expect(sealer.open(sealed.slice(0, -2), 0)).toBeNull();
    expect(sealer.open(`${sealed}00`, 0)).toBeNull();
  });

  it('is refused by a sealer that did not make it', () => {
    const sealed = new PendingLoginSealer().seal(LOGIN);
    expect(new PendingLoginSealer().open(sealed, 0)).toBeNull();
  });

  it('is refused when absent, empty, short or not hexadecimal', () => {
    const sealer = new PendingLoginSealer();
    for (const value of [undefined, '', '0', 'zz', 'ABCDEF', '00'.repeat(28), '00'.repeat(60)]) {
      expect(sealer.open(value, 0)).toBeNull();
    }
  });

  it('is refused when its fields are not ones the shell writes', () => {
    // A value the sealer itself made but whose fields are not what it writes.
    const sealer = new PendingLoginSealer();
    const odd = [
      { ...LOGIN, verifier: '' },
      { ...LOGIN, state: '' },
      { ...LOGIN, verifier: 'A.B' },
      { ...LOGIN, expiresAt: Number.NaN },
      { ...LOGIN, expiresAt: 1.5 },
    ];
    for (const login of odd) expect(sealer.open(sealer.seal(login), 0)).toBeNull();
  });
});

describe('the pending sign-ins already spent', () => {
  it('claims a key once, then calls it spent until it would have expired', () => {
    let now = 100;
    const spent = new SpentLogins(() => now);
    expect(spent.has('A')).toBe(false);
    expect(spent.claim('A', 200)).toBe('claimed');
    expect(spent.has('A')).toBe(true);
    expect(spent.claim('A', 200)).toBe('spent');
    now = 200;
    expect(spent.has('A')).toBe(false);
  });

  it('refuses a new claim when full of live ones, and makes room as they expire', () => {
    let now = 100;
    const spent = new SpentLogins(() => now);
    for (let i = 0; i < 10_000; i += 1) expect(spent.claim(`K${i}`, 200)).toBe('claimed');
    expect(spent.claim('NEW', 200)).toBe('full');
    now = 200;
    expect(spent.claim('NEW', 300)).toBe('claimed');
  });
});
