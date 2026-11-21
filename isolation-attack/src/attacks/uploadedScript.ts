// Uploaded script: the attacker, as the owner of tenant B, has uploaded a script,
// an HTML document and an SVG through Ghost's own file upload. Ghost serves
// them from the tenant's own origin, where `script-src 'self'` allows them, so
// only the edge's refusal stands between them and a reader's browser.

import { victimContext, visit } from '../browser.ts';
import type { UploadedScriptObservation, UploadVector } from '../observations.ts';
import type { World } from '../world.ts';

const MARK_FOR_KIND = { js: 'upload', html: 'upload_html', svg: 'upload_svg' } as const;

export async function attackUploadedScript(world: World): Promise<UploadedScriptObservation> {
  const vectors: UploadVector[] = [];
  for (const file of world.planted.uploads) {
    if (file.path === null) {
      vectors.push({
        name: file.kind,
        uploaded: false,
        uploadStatus: file.uploadStatus,
        fileStatus: null,
        ran: false,
      });
      continue;
    }
    const context = await victimContext(world.browser);
    try {
      let fileStatus: number | null = null;
      let ran = false;
      if (file.kind === 'js') {
        // The way a real attack loads it: a script tag in a page on the tenant.
        if (world.planted.uploadPostPath === null) {
          vectors.push({
            name: 'js',
            uploaded: true,
            uploadStatus: file.uploadStatus,
            fileStatus: null,
            ran: false,
          });
          continue;
        }
        const page = await context.newPage();
        page.on('response', (response) => {
          if (new URL(response.url()).pathname === file.path) fileStatus = response.status();
        });
        await page.goto(`${world.b.origin}${world.planted.uploadPostPath}`, {
          waitUntil: 'load',
          timeout: 30_000,
        });
        await page.waitForTimeout(1000);
        ran = await page.evaluate(
          (mark: string) => (window as unknown as Record<string, unknown>)[mark] === true,
          `__ran_${MARK_FOR_KIND.js}`
        );
      } else {
        // A document or an image navigated to directly runs its own script in the tenant's origin.
        const result = await visit(context, `${world.b.origin}${file.path}`);
        fileStatus = result.status;
        ran = result.marks[MARK_FOR_KIND[file.kind]] === true;
      }
      vectors.push({
        name: file.kind,
        uploaded: true,
        uploadStatus: file.uploadStatus,
        fileStatus,
        ran,
      });
    } finally {
      await context.close();
    }
  }
  return { vectors };
}
