import { describe, expect, it } from 'vitest';
import { isMediaEntryName, isSafeEntryName, splitUstarName } from '../../src/entryNames.js';

describe('isSafeEntryName', () => {
  it.each([
    'manifest.json',
    'content_and_settings.json',
    'content/images/a.png',
    'content/images/2026/11/photo@2x.png',
    'content/media/clip.mp4',
    'content/files/guide.pdf',
  ])('accepts %j', (name) => {
    expect(isSafeEntryName(name)).toBe(true);
  });

  it.each([
    '',
    '.',
    '..',
    '...',
    '/etc/passwd',
    '../up',
    'content/../../etc/passwd',
    'content/images/../../x',
    'content/images/./x',
    'content/images//x',
    'content/images/',
    'content/images',
    'content/images/size/w600/a.png',
    'content/other/a.png',
    'content/images/has space.png',
    'content/images/back\\slash.png',
    'content/images/%2e%2e/x',
    'content/images/ünï.png',
    'images/a.png',
    'dir/a.txt',
    `content/images/${'a'.repeat(101)}`,
    `content/images/${'a/'.repeat(130)}x`,
  ])('refuses %j', (name) => {
    expect(isSafeEntryName(name)).toBe(false);
  });
});

describe('splitUstarName', () => {
  it('leaves a short name whole and splits a long one at a slash', () => {
    expect(splitUstarName('a.txt')).toEqual({ prefix: '', name: 'a.txt' });
    const long = `content/images/${'d'.repeat(60)}/${'f'.repeat(60)}.png`;
    expect(isMediaEntryName(long)).toBe(true);
    const split = splitUstarName(long);
    expect(split).not.toBeNull();
    expect(`${split?.prefix}/${split?.name}`).toBe(long);
    expect(split?.name.length).toBeLessThanOrEqual(100);
  });

  it('returns null when no slash lets both halves fit', () => {
    expect(splitUstarName(`content/images/${'f'.repeat(120)}`)).toBeNull();
  });
});
