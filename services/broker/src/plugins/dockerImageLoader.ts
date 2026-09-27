/**
 * The `ImageLoader` seam (`../imagePush.ts`), filled -- the plugin
 * `server.ts` loads via `BROKER_IMAGE_LOADER_MODULE` in a real deploy.
 *
 * Never calls `docker` itself. LLD-2 §02's whole boundary is that the
 * broker's unprivileged user gets root for exactly the sudoers-enumerated
 * verbs a forced-command wrapper defines (`start`/`stop`/`reset`, and now
 * `load`) -- holding the Docker socket directly would be a wider, and
 * root-equivalent, grant than that. This module goes through the same
 * `SlotWrapper` (`../wrapper.ts`) `app.ts` already uses for
 * `start`/`stop`/`reset`, so there is exactly one place in the service that
 * ever builds a privileged invocation's argv, not two that could drift --
 * an audit for "does anything here ever shell out to `docker`" has exactly
 * one file to read either way, and it is not this one.
 *
 * `render_slot_sudoers.py`'s `load` rule grants exactly one literal
 * invocation: the wrapper path, then `load` and the one fixed tar path
 * `imagePush.ts` always stages a verified push at. That path is not
 * sudoers-enumerable the way a slot+colour+verb combination is (it names a
 * file, not one of a finite set of literals), so the sudoers layer cannot
 * itself refuse a different path the way it refuses a fourth argument on
 * `reset`. This module is the second, structural layer: it resolves the
 * path it is given with `realpath` -- through any symlink, collapsing any
 * `..` -- and refuses to go anywhere near the wrapper unless the resolved
 * path lives inside the resolved fixed directory. A tar that fails this
 * check is refused before a single privileged process is spawned.
 *
 * Requires the tar to have been produced with `docker save <content
 * digest>`, never `docker save <repo:tag>` -- see the error this throws
 * when `docker load`'s output carries a repo:tag instead of a bare image
 * ID, which is the shape a tag-based save produces and this loader
 * refuses to treat as a match for "runs it by digest only".
 */
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { wrapperConfigFromEnv } from '../config.js';
import type { ImageLoader } from '../imagePush.js';
import { createSlotWrapper } from '../wrapper.js';

const LOADED_IMAGE_ID_PATTERN = /Loaded image ID:\s*(sha256:[0-9a-f]{64})/;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/**
 * Both sides go through `realpath`, never a string-prefix compare on the
 * paths as given -- a symlink planted inside the fixed directory could
 * otherwise point this loader at a file living anywhere else on the host,
 * and a literal `..` in an unresolved path would compare as "inside" a
 * prefix it does not actually resolve under.
 */
async function assertInsideFixedDirectory(tarPath: string, fixedDir: string): Promise<void> {
  const [realFixedDir, realTarPath] = await Promise.all([realpath(fixedDir), realpath(tarPath)]);
  const boundary = realFixedDir.endsWith(sep) ? realFixedDir : `${realFixedDir}${sep}`;
  if (!realTarPath.startsWith(boundary)) {
    throw new Error(
      `refusing to load "${tarPath}" -- it resolves outside the fixed image-staging ` +
        `directory "${fixedDir}"`
    );
  }
}

const dockerImageLoader: ImageLoader = {
  async load(tarPath) {
    const fixedDir = requireEnv('BROKER_IMAGE_TMP_DIR');
    await assertInsideFixedDirectory(tarPath, fixedDir);

    const wrapper = createSlotWrapper(wrapperConfigFromEnv(process.env));
    const stdout = await wrapper.load(tarPath);

    const match = LOADED_IMAGE_ID_PATTERN.exec(stdout);
    if (!match?.[1]) {
      throw new Error(
        '"docker load" produced no bare image ID this loader recognises -- the tar must be ' +
          'saved by content digest ("docker save <imageId>"), never by a repo:tag reference, ' +
          `or "runs it by digest only" has nothing to check. Output:\n${stdout}`
      );
    }
    return { imageId: match[1] };
  },
};

export default dockerImageLoader;
