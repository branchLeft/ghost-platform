/**
 * The `ImageLoader` seam (`../imagePush.ts`), filled -- the plugin
 * `server.ts` loads via `BROKER_IMAGE_LOADER_MODULE` in a real deploy.
 * Never calls `docker` itself; goes through the same `SlotWrapper`
 * (`../wrapper.ts`) `app.ts` uses for `start`/`stop`/`reset`, so there is
 * exactly one place in the service that ever builds a privileged
 * invocation's argv. Requires the tar to have been produced with
 * `docker save <content digest>`, never `docker save <repo:tag>`.
 * See dockerImageLoader.md#dockerimageloader.
 */
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { wrapperConfigFromEnv } from '../config.js';
import type { ImageLoader } from '../imagePush.js';
import type { SeamMarker } from '../seamReadiness.js';
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

const dockerImageLoader: ImageLoader & SeamMarker = {
  real: true,
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
