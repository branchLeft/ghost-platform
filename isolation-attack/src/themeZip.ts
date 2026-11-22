// A Ghost theme as a stored (uncompressed) zip, built from Node built-ins only.
// The hostile theme is the base files plus the attacker's own, so the test
// owns exactly what the platform is asked to admit.

import { crc32 } from 'node:zlib';

export function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

export function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

/** The smallest theme Ghost's own validation accepts. */
export function baseThemeFiles(name: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name,
      description: 'A theme the attack suite supplies',
      version: '1.0.0',
      engines: { ghost: '>=5.0.0' },
      license: 'MIT',
      author: { email: 'theme-author@example.com' },
      config: { posts_per_page: 5 },
    }),
    'default.hbs':
      '<!DOCTYPE html><html><head>{{ghost_head}}</head><body>{{{body}}}{{ghost_foot}}</body></html>',
    'index.hbs': '{{!< default}}{{#foreach posts}}<a href="{{url}}">{{title}}</a>{{/foreach}}',
    'post.hbs': '{{!< default}}{{#post}}<h1>{{title}}</h1>{{{content}}}{{/post}}',
  };
}

export function buildZip(files: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const common = [
      u16(0),
      u16(0),
      u16(0),
      u16(0x21),
      u32(crc32(data)),
      u32(data.length),
      u32(data.length),
    ];
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      ...common,
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      ...common,
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
}

/** The names of the entries in a stored zip, read back from its central directory. */
export function zipEntryNames(zip: Buffer): string[] {
  const names: string[] = [];
  const endAt = zip.lastIndexOf(u32(0x06054b50));
  if (endAt < 0) throw new Error('not a zip: no end-of-directory record');
  const count = zip.readUInt16LE(endAt + 10);
  let at = zip.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('not a zip: bad directory entry');
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    names.push(zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
