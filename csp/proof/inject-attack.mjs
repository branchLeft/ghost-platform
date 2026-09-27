#!/usr/bin/env node
// Runs the hostile payload LLD-5's own spike measured
// (05-gate-and-edge.html §04) into a live Ghost via the same route a
// code-injection compromise would use: the Admin API's settings endpoint.
// Reuses the session cookie setup-content.mjs already minted
// (PROOF_SESSION_COOKIE) rather than logging in again -- a second login
// from a fresh process trips Ghost's own new-sign-in notification email,
// which 500s with no mail transport configured in this proof.
const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4310';
const SETUP_EMAIL = 'csp-proof-admin@example.test';
const SETUP_PASSWORD = 'CspProof123!';
const ATTACK = '<script>document.title="PWNED";window.__injectedRan=true;</script>';

async function call(path, options = {}, cookie) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    ...(options.headers || {}),
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(ORIGIN + path, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable body>');
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return res;
}

async function main() {
  let cookie = process.env.PROOF_SESSION_COOKIE;
  if (!cookie) {
    const sessionRes = await call('/ghost/api/admin/session/', {
      method: 'POST',
      body: JSON.stringify({ username: SETUP_EMAIL, password: SETUP_PASSWORD }),
    });
    const setCookie = sessionRes.headers.get('set-cookie');
    if (!setCookie) throw new Error('session: no Set-Cookie header returned');
    cookie = setCookie.split(';')[0];
  }

  await call(
    '/ghost/api/admin/settings/',
    {
      method: 'PUT',
      body: JSON.stringify({ settings: [{ key: 'codeinjection_head', value: ATTACK }] }),
    },
    cookie
  );
  console.log('codeinjection_head set to the attack payload.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
