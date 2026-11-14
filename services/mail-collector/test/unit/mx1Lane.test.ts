import { describe, expect, it } from 'vitest';
import { laneReturnPath, mx1Lane, parseLaneReturnPaths } from '../../src/mx1Lane.js';
import type { MailClass } from '../../src/sendingTarget.js';

const PATHS = { tx: 'bounce-tx@tx.example', nl: 'bounce-nl@nl.example' };

describe('mx1Lane', () => {
  it.each<[MailClass, boolean, 'tx' | 'nl']>([
    ['transactional', false, 'tx'],
    ['transactional', true, 'nl'],
    ['bulk', false, 'nl'],
    ['bulk', true, 'nl'],
  ])('%s, demo %s -> %s', (mailClass, demo, lane) => {
    expect(mx1Lane(mailClass, demo)).toBe(lane);
  });

  it('names the address of the lane', () => {
    expect(laneReturnPath(PATHS, 'transactional', false)).toBe(PATHS.tx);
    expect(laneReturnPath(PATHS, 'transactional', true)).toBe(PATHS.nl);
    expect(laneReturnPath(PATHS, 'bulk', false)).toBe(PATHS.nl);
  });
});

describe('parseLaneReturnPaths', () => {
  it('is absent when neither is set', () => {
    expect(parseLaneReturnPaths(undefined, undefined)).toBeUndefined();
    expect(parseLaneReturnPaths('', '')).toBeUndefined();
  });

  it('returns both when both are plain addresses on different domains', () => {
    expect(parseLaneReturnPaths(PATHS.tx, PATHS.nl)).toEqual(PATHS);
  });

  it.each([
    [PATHS.tx, undefined],
    [undefined, PATHS.nl],
  ])('refuses only one set (%s, %s)', (tx, nl) => {
    expect(() => parseLaneReturnPaths(tx, nl)).toThrow(/set together/);
  });

  it.each([
    'not-an-address',
    'Bounce <bounce@tx.example>',
    '<bounce@tx.example>',
    'a@b@tx.example',
    'bounce@localhost',
    'bounce@tx.example, other@tx.example',
    ' bounce@tx.example',
    'bounce@tx.example ',
    'bounce@-tx.example',
    '@tx.example',
  ])('refuses %j as not a plain address, whichever lane it is on', (bad) => {
    expect(() => parseLaneReturnPaths(bad, PATHS.nl)).toThrow(/plain address/);
    expect(() => parseLaneReturnPaths(PATHS.tx, bad)).toThrow(/plain address/);
  });

  it('refuses both on the same domain, in any case', () => {
    expect(() => parseLaneReturnPaths('bounce-tx@same.example', 'bounce-nl@same.example')).toThrow(
      /different domains/
    );
    expect(() => parseLaneReturnPaths('bounce-tx@SAME.example', 'bounce-nl@same.EXAMPLE')).toThrow(
      /different domains/
    );
  });
});
