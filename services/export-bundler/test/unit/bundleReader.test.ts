import { describe, expect, it } from 'vitest';
import { buildTar } from '../../src/archive.js';
import {
  BundleReadError,
  BundleRefusedError,
  openBundle,
  parseCsv,
  readTar,
} from '../../src/bundleReader.js';
import { tarListing, tarMember } from '../helpers/age.js';
import { bundleFiles, bundleTar } from '../helpers/promotionBundle.js';

describe('readTar', () => {
  it('reads back exactly what buildTar wrote, across block boundaries, agreeing with the system tar', () => {
    const binary = Buffer.alloc(1537);
    for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
    const tar = buildTar(
      [
        { name: 'a.json', data: '{"db":[]}' },
        { name: 'exact.bin', data: Buffer.alloc(512, 7) },
        { name: 'binary.bin', data: binary },
        { name: 'empty.txt', data: '' },
      ],
      1_700_000_000
    );
    const files = readTar(tar);
    expect(files.map((f) => f.name)).toEqual(tarListing(tar));
    for (const file of files) {
      expect(Buffer.from(file.data).equals(tarMember(tar, file.name))).toBe(true);
    }
  });

  it('refuses a damaged checksum, a truncated entry, a missing terminator and a stray byte after the data', () => {
    const tar = buildTar([{ name: 'a.txt', data: 'x'.repeat(700) }], 0);
    const badSum = Buffer.from(tar);
    badSum[0] = 'b'.charCodeAt(0);
    expect(() => readTar(badSum)).toThrow(/checksum/);
    expect(() => readTar(tar.subarray(0, 700))).toThrow(/truncated|terminator/);
    expect(() => readTar(tar.subarray(0, tar.length - 1024))).toThrow(/terminator/);
    const half = Buffer.from(tar);
    half[tar.length - 600] = 1;
    expect(() => readTar(half)).toThrow(BundleReadError);
  });

  it('refuses an entry that is not a regular file, one with a path prefix, and a repeated name', () => {
    const tar = buildTar([{ name: 'a.txt', data: 'x' }], 0);
    const link = Buffer.from(tar);
    link.write('2', 156, 1, 'ascii');
    refreshChecksum(link);
    expect(() => readTar(link)).toThrow(/not a regular file/);
    const prefixed = Buffer.from(tar);
    prefixed.write('dir', 345, 3, 'ascii');
    refreshChecksum(prefixed);
    expect(() => readTar(prefixed)).toThrow(/prefix/);
    const one = buildTar([{ name: 'a.txt', data: 'x' }], 0).subarray(0, 1024);
    const twice = Buffer.concat([one, one, Buffer.alloc(1024)]);
    expect(() => readTar(twice)).toThrow(/duplicate/);
  });

  it('refuses a name outside the safe set', () => {
    const tar = buildTar([{ name: 'a.txt', data: 'x' }], 0);
    const evil = Buffer.from(tar);
    evil.write('../up', 0, 5, 'ascii');
    evil.fill(0, 5, 100);
    refreshChecksum(evil);
    expect(() => readTar(evil)).toThrow(/unsafe/);
  });
});

function refreshChecksum(header: Buffer): void {
  header.write('        ', 148, 8, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i]!;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}

describe('parseCsv', () => {
  it('reads quoted fields with commas, doubled quotes, CRLF and line breaks inside', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi""\nthere"\r\n\r\nlast,\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"\nthere'],
      ['last', ''],
    ]);
  });

  it('counts a final record with no trailing newline and refuses an unclosed quote', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']]);
    expect(parseCsv('')).toEqual([]);
    expect(() => parseCsv('a\n"open')).toThrow(BundleReadError);
  });
});

describe('openBundle', () => {
  it('counts posts and pages apart, and members, and notes who is on a tier', () => {
    const bundle = openBundle(readTar(bundleTar()));
    expect(bundle.counts).toEqual({ posts: 4, pages: 2, members: 3 });
    expect(bundle.memberTiers.map((m) => m.email)).toEqual([
      'member-one@example.test',
      'member-three@example.test',
    ]);
  });

  it('counts a member whose name holds a comma, quote and line break once, not as extra records', () => {
    expect(openBundle(bundleFiles()).counts.members).toBe(3);
  });

  it.each([['content_and_settings.json'], ['members.json'], ['members.csv'], ['manifest.json']])(
    'refuses a bundle with no %s',
    (name) => {
      expect(() => openBundle(bundleFiles({ override: { [name]: null } }))).toThrow(
        BundleRefusedError
      );
    }
  );

  it('refuses a manifest that does not say members were read in full', () => {
    expect(() => openBundle(bundleFiles({ manifestMembers: { status: 'partial' } }))).toThrow(
      /manifest/
    );
    expect(() => openBundle(bundleFiles({ manifestMembers: { expected: 9 } }))).toThrow(/manifest/);
    expect(() => openBundle(bundleFiles({ manifestMembers: { present: 2 } }))).toThrow(/manifest/);
    expect(() => openBundle(bundleFiles({ override: { 'manifest.json': '{}' } }))).toThrow(
      /manifest/
    );
  });

  it('refuses a members CSV that lost a member, or holds another one, against members.json', () => {
    const lost = bundleFiles({
      override: { 'members.csv': 'id,email\nm0,member-one@example.test\n' },
    });
    expect(() => openBundle(lost)).toThrow(/members.csv holds 1 members/);
    const swapped = bundleFiles({
      override: {
        'members.csv':
          'id,email\nm0,member-one@example.test\nm1,member-two@example.test\nm2,other@example.test\n',
      },
    });
    expect(() => openBundle(swapped)).toThrow(/not the same people/);
    const noEmail = bundleFiles({ override: { 'members.csv': 'id,name\nm0,A\nm1,B\nm2,C\n' } });
    expect(() => openBundle(noEmail)).toThrow(/no email column/);
    const unclosed = bundleFiles({ override: { 'members.csv': 'id,email\n"m0,x\n' } });
    expect(() => openBundle(unclosed)).toThrow(BundleRefusedError);
  });

  it('refuses members with no email or a repeated one, and content or members that are not JSON', () => {
    expect(() =>
      openBundle(
        bundleFiles({ members: [{ email: 'a@example.test' }, { email: 'A@example.test' }] })
      )
    ).toThrow(/repeated/);
    expect(() =>
      openBundle(bundleFiles({ override: { 'content_and_settings.json': 'not json' } }))
    ).toThrow(/not JSON/);
    expect(() =>
      openBundle(bundleFiles({ override: { 'content_and_settings.json': '{"db":[]}' } }))
    ).toThrow(/no posts list/);
    expect(() => openBundle(bundleFiles({ override: { 'members.json': '{}' } }))).toThrow(
      /no members list/
    );
  });

  it('reads a members CSV that starts with a byte order mark', () => {
    const csv =
      '﻿id,email\nm0,member-one@example.test\nm1,member-two@example.test\nm2,member-three@example.test\n';
    expect(openBundle(bundleFiles({ override: { 'members.csv': csv } })).counts.members).toBe(3);
  });

  it('accepts string and Buffer entry data alike', () => {
    const files = bundleFiles({
      override: {
        'members.csv': Buffer.from(
          'id,email\nm0,member-one@example.test\nm1,member-two@example.test\nm2,member-three@example.test\n'
        ),
      },
    });
    expect(openBundle(files).counts.members).toBe(3);
  });
});
