// Builds a minimal, valid Ghost theme as a stored (uncompressed) zip using
// Node built-ins only, so the image test needs no install. `extraFiles` maps
// a path inside the theme to its bytes; that is where the bytes under test go.
import zlib from 'node:zlib';

const BASE_FILES = {
  'package.json': JSON.stringify({
    name: 'gate-test',
    description: 'PLACEHOLDER_THEME_DESCRIPTION',
    version: '1.0.0',
    engines: { ghost: '>=5.0.0' },
    license: 'MIT',
    author: { email: 'theme-author@example.com' },
    config: { posts_per_page: 5 },
  }),
  'default.hbs':
    '<!DOCTYPE html><html><head>{{ghost_head}}</head><body>{{{body}}}{{ghost_foot}}</body></html>',
  'index.hbs': '{{!< default}}{{#foreach posts}}{{title}}{{/foreach}}',
  'post.hbs': '{{!< default}}{{#post}}{{title}}{{/post}}',
};

function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

export function buildThemeZip(extraFiles = {}) {
  const files = { ...BASE_FILES, ...extraFiles };
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = zlib.crc32(data);
    const common = [
      u16(0),
      u16(0),
      u16(0),
      u16(0x21),
      u32(crc),
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
