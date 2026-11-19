import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * A demo slot's content directory: the three served trees, a resized variant,
 * and the scanning decorator's quarantine directory beside them.
 */
export const SERVED_FILES: Readonly<Record<string, string>> = {
  'images/2026/11/hero-AAAAAAAAAAAAAAAAAAAAAA.png': 'PNG-hero-bytes',
  'images/2026/11/hero-AAAAAAAAAAAAAAAAAAAAAA_o.png': 'PNG-hero-original',
  'images/logo.svg': '<svg/>',
  'media/2026/11/clip-BBBBBBBBBBBBBBBBBBBBBB.mp4': 'MP4-bytes',
  'files/2026/11/guide-CCCCCCCCCCCCCCCCCCCCCC.pdf': 'PDF-bytes',
};

/** Present on the volume and never carried. */
export const NOT_SERVED_FILES: Readonly<Record<string, string>> = {
  'images/size/w600/2026/11/hero-AAAAAAAAAAAAAAAAAAAAAA.png': 'RESIZED-variant',
  'quarantine/0123456789abcdef': 'QUARANTINED-bytes',
  'quarantine/0123456789abcdef.refused.json': '{}',
  'themes/casper/package.json': '{}',
};

export async function seedContentDir(
  files: Readonly<Record<string, string>> = { ...SERVED_FILES, ...NOT_SERVED_FILES }
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'export-bundler-media-'));
  for (const [rel, data] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }
  return dir;
}

/** Plants a symlink at `rel` pointing at `target`, which may lie outside the tree. */
export async function plantSymlink(dir: string, rel: string, target: string): Promise<void> {
  await mkdir(dirname(join(dir, rel)), { recursive: true });
  await symlink(target, join(dir, rel));
}
