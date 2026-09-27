/**
 * The `ImageLoader` seam (`../imagePush.ts`), filled — the plugin
 * `server.ts` loads via `BROKER_IMAGE_LOADER_MODULE` in a real deploy.
 *
 * `docker load`, never `docker pull`. LLD-4 U9 is load-bearing on exactly
 * that distinction: a host that pulls needs a registry credential and a
 * route to a registry; a host that only ever loads a tar that arrived over
 * its own already-open inbound connection (`imagePush.ts`, verified there
 * against its declared digest before this is ever called) needs neither.
 * This is the only file in the service that shells out to `docker` at all
 * — an audit for "does anything here ever pull" has exactly one file to
 * read, and grepping it for `pull` is `dockerImageLoader.test.ts`'s own
 * control.
 *
 * Requires the tar to have been produced with `docker save <content
 * digest>`, never `docker save <repo:tag>` — see the error this throws
 * when `docker load`'s output carries a repo:tag instead of a bare image
 * ID, which is the shape a tag-based save produces and this loader
 * refuses to treat as a match for "runs it by digest only".
 */
import { execFile } from 'node:child_process';

import type { ImageLoader } from '../imagePush.js';

const LOADED_IMAGE_ID_PATTERN = /Loaded image ID:\s*(sha256:[0-9a-f]{64})/;

function runDocker(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args as string[],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`docker ${args[0]} failed: ${err.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

const dockerImageLoader: ImageLoader = {
  async load(tarPath) {
    const stdout = await runDocker(['load', '-i', tarPath]);
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
