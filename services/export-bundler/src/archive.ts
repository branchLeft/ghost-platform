import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ArchiveFile {
  readonly name: string;
  readonly data: Buffer | string;
}

/**
 * LLD-8 §08b: "hands back one archive with a manifest saying what is in
 * it and what is not" -- one file, not a directory of loose exports.
 * `tar` is invoked with `execFile` and an explicit argv (never a shell
 * string), the same discipline services/broker/src/wrapper.ts already
 * applies to its own subprocess calls. The archive is written 0600 inside
 * a 0700 directory -- never anywhere world-readable, because a bulk
 * export of a tenant's members and content is exactly the kind of file a
 * stray default umask must not leave group- or world-readable.
 */
export async function writeTarArchive(
  destPath: string,
  files: readonly ArchiveFile[]
): Promise<void> {
  const destDir = dirname(destPath);
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  // `mode` on `mkdir` only applies when the directory is actually
  // created -- a directory that already existed (with looser
  // permissions inherited from whatever created it first) is left
  // untouched by the call above, so the invariant is enforced
  // unconditionally here too, the same defensive re-chmod auditLog.ts
  // applies to its own file.
  await chmod(destDir, 0o700);
  const stagingDir = await mkdtemp(join(tmpdir(), 'export-bundler-'));
  try {
    for (const file of files) {
      await writeFile(join(stagingDir, file.name), file.data, { mode: 0o600 });
    }
    await new Promise<void>((resolve, reject) => {
      // Explicit, minimal env -- never the ambient environment (see
      // containerRunner.ts's own comment; the same discipline applies to
      // every subprocess this package spawns).
      execFile(
        'tar',
        ['-cf', destPath, '-C', stagingDir, ...files.map((f) => f.name)],
        { env: { PATH: process.env.PATH ?? '' } },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`tar failed: ${err.message}: ${stderr}`));
            return;
          }
          resolve();
        }
      );
    });
    await chmod(destPath, 0o600);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
