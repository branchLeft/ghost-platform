// The "host" side of imagePush.live.test.ts, run inside a container on an
// `--internal` (no-egress) Docker network. It wires exactly the real
// compiled `handleImagePush` (this service's own control) to a real
// `docker`-backed `ImageLoader` plugin -- not a reimplementation, not a
// fixture standing in for the logic under test. It never imports
// `node:child_process` itself; only `wrapper.js` does (`dockerImageLoader.js`
// reaches it transitively, never `docker` directly), and
// `dockerImageLoader.js` is `dockerImageLoader.test.ts`'s own
// structural-scan target.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { handleImagePush } from '/app/dist/imagePush.js';
import { createInMemoryNonceStore } from '/app/dist/nonceStore.js';
import imageLoader from '/app/dist/plugins/dockerImageLoader.js';

const verifyKey = readFileSync(process.env.VERIFY_KEY_FILE);
const processStartSeconds = Math.floor(Date.now() / 1000);

const auth = {
  verifyKey,
  replayWindowSeconds: 60,
  nonces: createInMemoryNonceStore(60_000),
  processStartSeconds,
  nowMs: () => Date.now(),
};

const push = {
  loader: imageLoader,
  tmpDir: '/tmp',
  maxBytes: 4 * 1024 * 1024 * 1024,
  nowMs: () => Date.now(),
  log: (line) => console.error(line),
};

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/image') {
    void handleImagePush(auth, push, req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = Number(process.env.PORT || '8099');
server.listen(port, '0.0.0.0', () => {
  console.log(`host receiver listening on 0.0.0.0:${port}`);
});
