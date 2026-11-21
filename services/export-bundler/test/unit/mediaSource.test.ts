import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleanupRegistry } from '../../src/cleanup.js';
import {
  buildMediaReadArgs,
  createContainerMediaSource,
  MEDIA_READ_SCRIPT,
  isRootUser,
  MediaFrameParser,
  MediaReaderRootError,
  MediaReadError,
  readFrames,
  type MediaContainerSpec,
} from '../../src/mediaSource.js';
import { MediaTreeRefusedError, MediaTreeTooLargeError } from '../../src/mediaTree.js';

const LIMITS = { uploadCeilingBytes: 100, maxCarriedBytes: 1000 };
const SHA = 'a'.repeat(64);
const line = (o: object): Buffer => Buffer.from(`${JSON.stringify(o)}\n`);
const stream = (...parts: (Buffer | object)[]): Buffer =>
  Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : line(p))));

describe('MediaFrameParser', () => {
  function parse(buffer: Buffer, step = buffer.length): MediaFrameParser {
    const parser = new MediaFrameParser(LIMITS);
    for (let i = 0; i < buffer.length; i += step) parser.push(buffer.subarray(i, i + step));
    return parser;
  }

  const good = stream(
    { t: 'file', p: 'images/a.png', n: 5 },
    Buffer.from('hello'),
    { t: 'file', p: 'files/empty', n: 0 },
    { t: 'big', p: 'media/big.mp4', n: 5000, sha256: SHA },
    { t: 'done' }
  );

  it.each([1, 3, 7, 1000])(
    'reads files, an empty file, an oversized one and the end, %i bytes at a time',
    (step) => {
      const entries = parse(good, step).finish();
      expect(entries.map((e) => [e.rel, e.size, e.data?.toString() ?? null, e.sha256])).toEqual([
        ['images/a.png', 5, 'hello', null],
        ['files/empty', 0, '', null],
        ['media/big.mp4', 5000, null, SHA],
      ]);
    }
  );

  it('carries bytes that look like a frame as bytes, not as a frame', () => {
    const body = '{"t":"refused","p":"x","why":"y"}\n';
    const entries = parse(
      stream({ t: 'file', p: 'files/odd', n: body.length }, Buffer.from(body), { t: 'done' })
    ).finish();
    expect(entries[0]?.data?.toString()).toBe(body);
  });

  it('a refusal frame throws the refusal by name, with the content prefix', () => {
    const parser = parse(
      stream({ t: 'file', p: 'images/a', n: 1 }, Buffer.from('x'), {
        t: 'refused',
        p: 'images/x/link',
        why: 'a symbolic link',
      })
    );
    expect(() => parser.finish()).toThrow(MediaTreeRefusedError);
    expect(() => parser.finish()).toThrow(/content\/images\/x\/link.*symbolic link/);
  });

  it.each([
    ['a stream cut before done', stream({ t: 'file', p: 'images/a', n: 1 }, Buffer.from('x'))],
    ['a stream cut inside a file', stream({ t: 'file', p: 'images/a', n: 9 }, Buffer.from('xx'))],
    ['an empty stream', Buffer.alloc(0)],
  ])('refuses %s', (_name, buffer) => {
    expect(() => parse(buffer).finish()).toThrow(MediaReadError);
  });

  it.each([
    ['not JSON', Buffer.from('nonsense\n')],
    ['an unknown frame', stream({ t: 'symlink', p: 'a' })],
    ['a file with a negative size', stream({ t: 'file', p: 'a', n: -1 })],
    ['a file with a fractional size', stream({ t: 'file', p: 'a', n: 1.5 })],
    ['a file frame with no path', stream({ t: 'file', n: 1 })],
    ['a file over the upload ceiling', stream({ t: 'file', p: 'a', n: 101 })],
    ['a checksum that is not a sha256', stream({ t: 'big', p: 'a', n: 1, sha256: 'zz' })],
    ['data after done', stream({ t: 'done' }, Buffer.from('extra'))],
    ['a frame after a refusal', stream({ t: 'refused', p: 'a', why: 'b' }, { t: 'done' })],
    ['a header that never ends', Buffer.alloc(9000, 0x61)],
  ])('refuses %s', (_name, buffer) => {
    expect(() => parse(buffer)).toThrow(MediaReadError);
  });

  it('refuses, by name, more carried bytes than the host holds', () => {
    const files = Array.from({ length: 11 }, (_, i) => [
      { t: 'file', p: `files/f${i}`, n: 100 },
      Buffer.alloc(100),
    ]).flat();
    expect(() => parse(stream(...files))).toThrow(MediaTreeTooLargeError);
  });
});

describe('buildMediaReadArgs', () => {
  const spec: MediaContainerSpec = {
    runId: 'tenant-export-9',
    image: 'ghost-platform:test',
    user: '1001:1001',
    volume: 'tenant-content',
  };
  const args = buildMediaReadArgs(spec, LIMITS);
  const at = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it('mounts the content volume read-only and nothing else', () => {
    const mounts = args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));
    expect(mounts).toEqual(['type=volume,src=tenant-content,dst=/var/lib/ghost/content,readonly']);
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--volumes-from');
  });

  it('runs unprivileged, with no network, no capability, a read-only root and no log', () => {
    expect(at('--user')).toBe('1001:1001');
    expect(at('--network')).toBe('none');
    expect(at('--cap-drop')).toBe('ALL');
    expect(at('--security-opt')).toBe('no-new-privileges');
    expect(args).toContain('--read-only');
    expect(at('--log-driver')).toBe('none');
    expect(args).toContain('--rm');
    expect(args).not.toContain('--privileged');
    expect(at('--name')).toBe('tenant-export-9-media');
  });

  it('never runs as root: a stack with no user falls back to the image user, not 0', () => {
    const noUser = buildMediaReadArgs({ ...spec, user: null }, LIMITS);
    expect(noUser[noUser.indexOf('--user') + 1]).toBe('node');
  });

  it.each([['0'], ['00'], ['0:0'], ['0:1001'], ['root'], ['root:node'], ['ROOT'], [' 0 ']])(
    'REFUSES to run the reader as root: the stack user %j',
    (user) => {
      expect(() => buildMediaReadArgs({ ...spec, user }, LIMITS)).toThrow(MediaReaderRootError);
    }
  );

  it.each([['1001:1001'], ['1000'], ['node'], ['node:node'], ['10:0'], ['100']])(
    'runs the reader for the unprivileged user %j',
    (user) => {
      expect(isRootUser(user)).toBe(false);
      expect(() => buildMediaReadArgs({ ...spec, user }, LIMITS)).not.toThrow();
    }
  );

  it('the container source refuses a root stack user before any docker is run', async () => {
    const registry = new CleanupRegistry();
    await expect(
      createContainerMediaSource(
        { ...spec, user: '0:0' },
        { dockerCommand: '/nonexistent/docker', registry }
      ).read(LIMITS)
    ).rejects.toBeInstanceOf(MediaReaderRootError);
    expect(registry.labels).toEqual([]);
  });

  it('runs the reader script on the mounted directory with the upload ceiling', () => {
    const tail = args.slice(args.indexOf('ghost-platform:test'));
    expect(tail).toEqual([
      'ghost-platform:test',
      '-e',
      MEDIA_READ_SCRIPT,
      '/var/lib/ghost/content',
      '100',
    ]);
  });
});

describe('the reader script', () => {
  it('opens children of a held descriptor, never a path it built from the volume root', () => {
    expect(MEDIA_READ_SCRIPT).toContain("'/proc/self/fd/'");
    expect(MEDIA_READ_SCRIPT).toContain('O_NOFOLLOW');
    expect(MEDIA_READ_SCRIPT).not.toMatch(/path\.join|contentDir \+/);
    expect(MEDIA_READ_SCRIPT).not.toMatch(/readdirSync\(rel|readdirSync\(contentDir/);
  });
});

describe('readFrames and the container source, with a stand-in for docker', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'export-bundler-media-source-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeDocker(output: Buffer, exitCode: number, stderr = ''): Promise<string> {
    const frames = join(dir, 'frames.bin');
    await writeFile(frames, output);
    const script = join(dir, 'docker');
    await writeFile(
      script,
      `#!/bin/sh\ncat '${frames}'\n${stderr ? `echo '${stderr}' >&2\n` : ''}exit ${String(exitCode)}\n`
    );
    await chmod(script, 0o755);
    return script;
  }

  const spec: MediaContainerSpec = { runId: 'r1', image: 'img', user: null, volume: 'vol' };

  it('reads the entries a container wrote, and takes its remover off the registry after', async () => {
    const docker = await fakeDocker(
      stream({ t: 'file', p: 'images/a.png', n: 2 }, Buffer.from('ok'), { t: 'done' }),
      0
    );
    const registry = new CleanupRegistry();
    const entries = await createContainerMediaSource(spec, {
      dockerCommand: docker,
      registry,
    }).read(LIMITS);
    expect(entries.map((e) => e.rel)).toEqual(['images/a.png']);
    expect(registry.labels).toEqual([]);
  });

  it('a refusal frame becomes the refusal, whatever the exit code', async () => {
    const docker = await fakeDocker(
      stream({ t: 'refused', p: 'images/link', why: 'a symbolic link' }),
      3
    );
    await expect(
      createContainerMediaSource(spec, {
        dockerCommand: docker,
        registry: new CleanupRegistry(),
      }).read(LIMITS)
    ).rejects.toBeInstanceOf(MediaTreeRefusedError);
  });

  it('a container that fails, or is cut off, is an error carrying its message', async () => {
    const failed = await fakeDocker(Buffer.alloc(0), 1, 'EACCES: permission denied');
    await expect(readFrames(failed, [], LIMITS, new CleanupRegistry())).rejects.toThrow(
      /stream ended early; EACCES/
    );
    const cut = await fakeDocker(stream({ t: 'file', p: 'images/a', n: 1 }), 0);
    await expect(readFrames(cut, [], LIMITS, new CleanupRegistry())).rejects.toBeInstanceOf(
      MediaReadError
    );
    const nonzero = await fakeDocker(stream({ t: 'done' }), 2);
    await expect(readFrames(nonzero, [], LIMITS, new CleanupRegistry())).rejects.toThrow(/exit 2/);
  });

  it('garbage from the container is an error', async () => {
    const docker = await fakeDocker(Buffer.from('not a frame\n'), 0);
    await expect(readFrames(docker, [], LIMITS, new CleanupRegistry())).rejects.toThrow(/not JSON/);
  });

  it('reports a docker that cannot be started', async () => {
    await expect(
      readFrames(join(dir, 'missing'), [], LIMITS, new CleanupRegistry())
    ).rejects.toThrow(/ENOENT/);
  });
});
