# signedRequestScheme.ts

## Why it exists

The verdict host (`adapters/scanning-storage/verdict-host/`) must recognise the
safety service by the broker's signed-request scheme, and it runs as plain
CommonJS on the Ghost image's Node. It used to carry a hand-written port of
`auth.ts`, `signing.ts` and `nonceStore.ts`. A port of a safety check drifts:
the order of its steps is the control, and a second copy is a second place
for that order to be got wrong. The never-copy rule applies, so the scheme has
one home, here in the broker, and the host builds what it needs from it.

## What is exported, and what is not

`signedRequestScheme.ts` is the whole surface another process may take:
`checkRequest` (the ordered check, `auth.ts`), `createInMemoryNonceStore`,
`nonceLifetimeMs` (how long a spent nonce is kept) and `publicKeyFromRaw`. The signing side
(`privateKeyFromRaw`, `signRequest`) is not exported, so a bundle built from
this file holds no signing code: the host holds only the public key.
`test/unit/signedRequestScheme.test.ts` pins the list.

## How the host gets it

`pnpm run build:shared` in `adapters/scanning-storage/` bundles this file with
esbuild into `verdict-host/generated/signed-request.cjs`. That file is
git-ignored: it is a build product, never a second copy to review. The unit
tests build it first, as does anything that starts the process. The host's
`auth.js` keeps only what is the host's own (reading the key file, the replay
window default, the header names) and calls the bundle for everything else.

## The guard

The same test file scans `adapters/` for the two things only the scheme owns,
the Ed25519 key wrapper prefix and the forward-skew constant. A source file
there that carries either fails the broker's CI, which is why the broker's
workflow also starts on a change under `adapters/scanning-storage/verdict-host/`.

## Not covered

`services/storage-gateway/src/credentials/adminAuth.ts` has its own admin
signing variant with different rules (it is a different scheme, not a port of
this one). It is outside this guard; folding it in is a separate change.
