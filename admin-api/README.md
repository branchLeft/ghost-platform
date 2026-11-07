# admin-api

The one home of Ghost Admin API access in this repo. Zero dependencies:
`node:crypto`, `node:http` and `node:https` only. Private, never published.

## What lives here

- `src/key.js`: the Admin API key shape (`id:secret`, 24 and 64 hex digits)
  and `isAdminApiKey`.
- `src/token.js`: `adminApiToken(key, nowSeconds)`, the short-lived token
  Ghost verifies (HS256 over the hex-decoded secret, `kid` naming the key,
  audience `/admin/`, five minutes). This file is the only place in the repo
  that mints it; `test/singleHome.test.js` fails if any other source file does.
- `src/client.js`: `createAdminApiClient`, a read-only client.
- `src/cli.js`: a thin command line over the client.
- `index.js` and `index.d.ts`: the export surface and its hand-written types.
  `test/types.test.js` fails if the two disagree about which names exist.

The broker (`services/broker`) takes `isAdminApiKey` and `adminApiToken` from
here, through `link:../../admin-api` exactly as it takes `render-core`, and
esbuild bundles them into its single-file output. Its
`src/ghostAdmin/token.ts` and `keyStore.ts` re-export them, so nothing else in
the broker changed.

## The client

```js
import { createAdminApiClient } from '@branchleft/ghost-platform-admin-api';

const client = createAdminApiClient({ baseUrl, key });
await client.memberCount();
await client.findMemberByEmail(email); // the member, or null
await client.listNewsletters();
await client.getSetting('title');
await client.membersSupportAddress(); // a string, or null if unset
await client.exportMembersCsv(); // the CSV text
```

There is no write path: only `GET` is ever issued. What it guarantees:

- **The key stays in a closure.** It is checked with `isAdminApiKey`, never
  put in an error, a log line, `toString` or `JSON.stringify`, and the client
  has no enumerable property that holds it.
- **The URL is checked before any socket opens.** `https:` on any host;
  `http:` only on `localhost`, `127.0.0.1` or `[::1]`; no userinfo, query or
  fragment.
- **A redirect is an error.** The transport is `node:http(s)`, which never
  follows one, and any 3xx is reported as `redirect`.
- **One total deadline,** from send to the last body byte (not an idle timer,
  which a server trickling bytes would reset for ever). The response body is
  capped at 16 MiB.
- **Errors say little.** `AdminApiError`'s message is exactly
  `METHOD /path -> status` (or `timeout`, `network`, `redirect`,
  `bad-response`). The path has no query string, so an email that was looked
  up never lands in an error. No body, no header, no key.

## The CLI

```sh
read -rs GHOST_ADMIN_API_KEY; export GHOST_ADMIN_API_KEY
node admin-api/src/cli.js --url https://ghost.example.test member-count
```

Commands: `member-count`, `find-member <email>`, `newsletters`,
`setting <key>`, `support-address`, `export-members`. JSON goes to stdout, the
members CSV raw. The CLI never writes a file and never picks a location in a
repo: redirect `export-members` yourself, somewhere that is not a repo.

The key is read from `GHOST_ADMIN_API_KEY` and nowhere else. There is no
`--key` flag and no key file; an unknown option is an error, and no message
echoes an argument. Exit 0 on success, 1 on an API error, 2 on bad usage or a
missing key (the message names the variable, never a value).

Running it against a real tenant reads member-side state, and `export-members`
reads member emails. That is the owner's to run, not an agent's.

## Tests

```sh
cd admin-api
node --test "test/*.test.js"
```

`test/sabotage.test.js` breaks each safety control in a copy of the package
(the secret not hex-decoded, a 3xx counted as success, the key in an error,
any `http:` accepted, an idle timer for the deadline) and requires the copy's
own suite to go red; it also requires the untouched copy to go green. Each
replacement is an exact string match that must match once, so it cannot go
stale quietly.
