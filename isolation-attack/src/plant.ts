// What the attacker (the owner of tenant B) puts on B, and what the victim
// (the owner of tenant A) has on A for the attacker to aim at. Planting goes
// through the edge like any tenant's own edit, so a control that refuses the
// plant itself shows as an upload Ghost or the edge refused, not as a crash.

import type { TenantHandle, UploadedFile, Planted } from './world.ts';
import {
  footInjection,
  forgedFormCard,
  headInjection,
  inlineCard,
  scriptCard,
  uploadedHtmlSource,
  uploadedScriptSource,
  uploadedSvgSource,
  type AttackerContext,
} from './payloads.ts';

interface UploadSpec {
  readonly kind: UploadedFile['kind'];
  readonly name: string;
  readonly mime: string;
  readonly source: (a: AttackerContext) => string;
}

const UPLOADS: readonly UploadSpec[] = [
  { kind: 'js', name: 'attack-suite.js', mime: 'text/javascript', source: uploadedScriptSource },
  {
    kind: 'html',
    name: 'attack-suite.html',
    mime: 'text/html',
    source: () => uploadedHtmlSource(),
  },
  {
    kind: 'svg',
    name: 'attack-suite.svg',
    mime: 'image/svg+xml',
    source: () => uploadedSvgSource(),
  },
];

export async function plant(
  attackerTenant: TenantHandle,
  victimTenant: TenantHandle,
  attacker: AttackerContext
): Promise<Planted> {
  const b = attackerTenant.admin;

  await b.setSetting('codeinjection_head', headInjection(attacker));
  await b.setSetting('codeinjection_foot', footInjection());

  const inline = await b.publishHtmlPost('Inline script post', inlineCard());

  const uploads: UploadedFile[] = [];
  for (const spec of UPLOADS) {
    const result = await b.uploadFile(spec.name, Buffer.from(spec.source(attacker)), spec.mime);
    uploads.push({
      kind: spec.kind,
      name: spec.name,
      uploadStatus: result.status,
      path: result.url === null ? null : new URL(result.url, attackerTenant.origin).pathname,
    });
  }
  const js = uploads.find((u) => u.kind === 'js');
  const uploadPost =
    js?.path === null || js === undefined
      ? null
      : await b.publishHtmlPost('Uploaded script post', scriptCard(js.path));

  const victimPost = await victimTenant.admin.publishPlainPost('Victim post');
  const csrf = await b.publishHtmlPost(
    'Forged request post',
    forgedFormCard(`${victimTenant.origin}/ghost/api/admin/posts/${victimPost.id}/copy/`)
  );

  return {
    inlinePostPath: `/${inline.slug}/`,
    uploadPostPath: uploadPost === null ? null : `/${uploadPost.slug}/`,
    csrfPostPath: `/${csrf.slug}/`,
    uploads,
    victimPostId: victimPost.id,
  };
}
