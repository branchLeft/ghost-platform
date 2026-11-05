#!/usr/bin/env node
// The uploaded-script attack (branchLeft/workspace#3078): a tenant uploads a
// .js file through Ghost's own files endpoint, which Ghost then serves from
// the tenant's own origin, and plants a post whose HTML card loads it with
// `<script src>`. The strict policy's `script-src 'self'` allows that, so
// only the edge's refusal of the uploaded file stops it.
//
// Needs a verdict source on the storage adapter (the harness sets
// `storage__files__verdictSource=in-process-fake`, a test-only value: a demo
// renders none, and the scanning adapter then refuses every upload with a 503).
//
// Reuses the session cookie setup-content.mjs minted (PROOF_SESSION_COOKIE).
// Prints two shell-eval-able lines, the post's path and the script's path,
// for csp/proof/capture-csp.mjs.
const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4310';
const COOKIE = process.env.PROOF_SESSION_COOKIE;
const SCRIPT = "window.__uploadedRan = true; document.title = 'PWNED-BY-UPLOAD';";

async function call(path, options = {}) {
  const res = await fetch(ORIGIN + path, {
    ...options,
    headers: { Origin: ORIGIN, Cookie: COOKIE, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable body>');
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function main() {
  if (!COOKIE) throw new Error('PROOF_SESSION_COOKIE is required (setup-content.mjs prints it)');

  const form = new FormData();
  form.append('file', new Blob([SCRIPT], { type: 'text/javascript' }), 'x.js');
  const uploaded = await call('/ghost/api/admin/files/upload/', { method: 'POST', body: form });
  const scriptPath = new URL(uploaded.files[0].url).pathname;

  const lexical = {
    root: {
      type: 'root',
      version: 1,
      direction: null,
      format: '',
      indent: 0,
      children: [{ type: 'html', version: 1, html: `<script src="${scriptPath}"></script>` }],
    },
  };
  const created = await call('/ghost/api/admin/posts/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      posts: [
        { title: 'Upload attack post', lexical: JSON.stringify(lexical), status: 'published' },
      ],
    }),
  });
  console.log(`UPLOAD_POST_PATH=/${created.posts[0].slug}/`);
  console.log(`UPLOAD_SCRIPT_PATH=${scriptPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
