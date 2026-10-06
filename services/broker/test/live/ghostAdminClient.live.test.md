# ghostAdminClient.live.test.ts

The admin client's proof against a real Ghost: the pinned image
(`../../../../Dockerfile`'s `FROM`), production mode, sqlite, run twice on
one data volume the way a colour swap runs two colours. It skips unless
Docker answers and that image is already present locally, so CI never
pulls it implicitly.

In order, on one site:

1. **First build**: setup, the owner's staff token stored at 0600 in a
   0700 folder, all three settings read back through Ghost's own API.
2. **Swap**: the settings are tampered with, a second colour starts on the
   same data, and configure against it restores all three, using the
   stored token, and the new colour reads back the restored values. The
   old colour is not checked: each Ghost process caches settings in
   memory, so it keeps its own view until the swap drains and stops it.
3. **Regenerated token**: the token is regenerated through Ghost, as the
   prospect would in their profile. The next configure throws
   `AdminAccessLostError`, and a setting written with the new token is
   left as it was.
4. **Reset**: `forget` deletes the token file.

Run it with `npx vitest run test/live/ghostAdminClient.live.test.ts` after
`docker pull` of the pinned image.
