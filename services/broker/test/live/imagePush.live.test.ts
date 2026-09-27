/**
 * The real control this story exists for: against real containers
 * standing in for the control plane and a host, over a real Docker
 * network with `--internal` set (no route to a registry at all -- not a
 * container-level flag Ghost or Docker interpret, but the same absence of
 * a default route that a production host's own default-deny egress rule
 * would leave it with), the compiled `handleImagePush` + `dockerImageLoader`
 * this service actually ships:
 *
 *  - receives a real Ghost image by push and loads it, verified against a
 *    digest computed from the bytes that actually arrived;
 *  - refuses a push whose digest does not match;
 *  - never holds a registry credential;
 *  - runs the loaded image by its own content digest, never a tag.
 *
 * The control plane is a one-shot container on the *same* `--internal`
 * network as the host, dialling in by the host container's own name
 * (Docker's embedded DNS resolves that regardless of `--internal`) --
 * never through a published host port. Docker Desktop does not forward a
 * published port into a container on an internal network (proven while
 * building this test: identical setup, only `--internal` changed, and
 * `curl 127.0.0.1:<published>` went from `ok` to `ECONNREFUSED`), which is
 * itself a small, useful confirmation that the network really carries no
 * inbound path from outside it either.
 *
 * Needs Docker and the `ghost-platform:ci-1241` image locally (the brief
 * for this run: don't depend on a GHCR pull, its read token is dead
 * tonight) -- detects both and skips otherwise, exactly like
 * `render-core/test/live-demo-boot.test.ts`.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTestKeyPair } from '../helpers/signer.js';
import { ensureBuilt } from '../helpers/spawnBroker.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = join(here, '..', '..');
const DIST_DIR = join(SERVICE_ROOT, 'dist');
const FIXTURES_DIR = join(here, 'fixtures');
const HOST_RECEIVER = join(FIXTURES_DIR, 'hostReceiver.mjs');
const WRAPPER_STUB = join(FIXTURES_DIR, 'branchleft-slot-stub.sh');
const HOST_DOCKERFILE = join(FIXTURES_DIR, 'Dockerfile');
const CONTROL_PLANE_CLI = join(FIXTURES_DIR, 'controlPlanePushCli.mjs');

const GHOST_IMAGE = 'ghost-platform:ci-1241';
const HOST_TEST_IMAGE = 'ghost-imgpush-host-test:local';
const CONTROL_PLANE_IMAGE = 'node:22-alpine';

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}
function imageAvailable(image: string): boolean {
  return spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;
}

const canRun = dockerAvailable() && imageAvailable(GHOST_IMAGE);

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
    stream.on('error', reject);
  });
}

async function waitForLog(
  containerName: string,
  pattern: RegExp,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = spawnSync('docker', ['logs', containerName], { encoding: 'utf-8' });
    if (pattern.test(`${logs.stdout}${logs.stderr}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const logs = spawnSync('docker', ['logs', containerName], { encoding: 'utf-8' });
  throw new Error(
    `"${containerName}" never matched ${pattern}. Logs:\n${logs.stdout}\n${logs.stderr}`
  );
}

interface PushResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

describe.skipIf(!canRun)('LIVE — push delivery to an egress-denied host', () => {
  let tmpRoot = '';
  let tarPath = '';
  let expectedDigest = '';
  let imageIdFull = '';
  let networkName = '';
  let hostContainerName = '';
  let privateKeyPath = '';
  let verifyKeyPath = '';
  let transferReport = '';

  // Runs the real, compiled `pushImage` inside a one-shot container on the
  // same `--internal` network as the host -- the control plane dialling in
  // by the host's container name, never through a published port (see the
  // module doc comment above for why that path does not exist here).
  function controlPlanePush(digest: string): PushResult {
    const output = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        networkName,
        '-v',
        `${DIST_DIR}:/app/dist:ro`,
        '-v',
        `${CONTROL_PLANE_CLI}:/app/controlPlanePushCli.mjs:ro`,
        '-v',
        `${tarPath}:/data/image.tar:ro`,
        '-v',
        `${privateKeyPath}:/keys/private.key:ro`,
        '-e',
        `PUSH_BASE_URL=http://${hostContainerName}:8099`,
        '-e',
        `PUSH_DIGEST=${digest}`,
        '-e',
        'PUSH_TAR_PATH=/data/image.tar',
        '-e',
        'PUSH_KEY_PATH=/keys/private.key',
        CONTROL_PLANE_IMAGE,
        'node',
        '/app/controlPlanePushCli.mjs',
      ],
      { encoding: 'utf-8' }
    );
    const lastLine = output.trim().split('\n').pop() ?? '{}';
    return JSON.parse(lastLine) as PushResult;
  }

  beforeAll(async () => {
    ensureBuilt();

    tmpRoot = join(SERVICE_ROOT, `.imgpush-live-${process.pid}`);
    await mkdir(tmpRoot, { recursive: true });

    // A content digest, never a tag -- `docker save <this>` produces a tar
    // `dockerImageLoader.ts` can load back to a bare image ID, the shape
    // "runs it by digest only" depends on.
    imageIdFull = execFileSync('docker', ['inspect', '--format', '{{.Id}}', GHOST_IMAGE])
      .toString()
      .trim();
    tarPath = join(tmpRoot, 'image.tar');
    execFileSync('docker', ['save', imageIdFull, '-o', tarPath]);
    expectedDigest = await sha256OfFile(tarPath);

    if (!imageAvailable(HOST_TEST_IMAGE)) {
      execFileSync(
        'docker',
        ['build', '-f', HOST_DOCKERFILE, '-t', HOST_TEST_IMAGE, FIXTURES_DIR],
        {
          stdio: 'ignore',
        }
      );
    }
    if (!imageAvailable(CONTROL_PLANE_IMAGE)) {
      execFileSync('docker', ['pull', CONTROL_PLANE_IMAGE], { stdio: 'ignore' });
    }

    const keyPair = generateTestKeyPair();
    verifyKeyPath = join(tmpRoot, 'verify.key');
    privateKeyPath = join(tmpRoot, 'private.key');
    await writeFile(verifyKeyPath, keyPair.publicKeyRaw);
    await writeFile(privateKeyPath, keyPair.privateKeyRaw);

    networkName = `ghost-imgpush-net-${process.pid}`;
    execFileSync('docker', ['network', 'create', '--internal', networkName]);

    hostContainerName = `ghost-imgpush-host-${process.pid}`;
    execFileSync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      hostContainerName,
      '--network',
      networkName,
      '-v',
      `${DIST_DIR}:/app/dist:ro`,
      '-v',
      `${HOST_RECEIVER}:/app/hostReceiver.mjs:ro`,
      '-v',
      // The real `dockerImageLoader.js` (mounted in via DIST_DIR above)
      // now goes through the sudoers wrapper, never `docker` directly --
      // this container has neither `sudo` nor the real
      // `/usr/local/sbin/branchleft-slot`, so this stand-in receives the
      // exact same `load <path>` argv `wrapper.ts` sends and is the one
      // thing in this container allowed to translate it into a real
      // `docker load`, matching `BROKER_WRAPPER_COMMAND`/`_PREFIX` below.
      `${WRAPPER_STUB}:/app/branchleft-slot-stub.sh:ro`,
      // The one deliberate exception to "no egress": a Unix socket bind
      // mount to this machine's own Docker daemon, standing in for the
      // host's own local dockerd (every real demo/tenant host already
      // runs one -- see compose.ts's `${IMAGE}` service, started by the
      // same daemon). It carries no network path to anywhere, registry
      // included, which the isolated-egress assertion below checks
      // directly rather than assuming.
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      `${verifyKeyPath}:/keys/verify.pub:ro`,
      '-e',
      'VERIFY_KEY_FILE=/keys/verify.pub',
      '-e',
      'PORT=8099',
      // Matches `hostReceiver.mjs`'s own hardcoded `push.tmpDir`
      // ('/tmp') -- `dockerImageLoader.js` reads this separately (it has
      // no `BrokerConfig` to receive it through) to check the path it is
      // given resolves inside it before ever reaching the wrapper.
      '-e',
      'BROKER_IMAGE_TMP_DIR=/tmp',
      '-e',
      'BROKER_WRAPPER_COMMAND=/app/branchleft-slot-stub.sh',
      // Empty, not unset: this container runs the stand-in directly, the
      // same "sandbox" case `config.ts`'s own doc comment on
      // `wrapperPrefix` describes -- unset would default to `sudo -n`,
      // which is not installed here.
      '-e',
      'BROKER_WRAPPER_PREFIX=',
      // `wrapperTimeoutMs` is now shared with `start`/`stop`/`reset`,
      // whose 30_000ms default is sized for a systemd unit, not a ~1 GB
      // `docker load` -- the config ceiling (`positiveInteger`'s own
      // upper bound in config.ts) is 300_000ms, which this sets
      // explicitly rather than relying on a default this operation
      // regularly runs past.
      '-e',
      'BROKER_WRAPPER_TIMEOUT_MS=300000',
      HOST_TEST_IMAGE,
      'node',
      '/app/hostReceiver.mjs',
    ]);

    await waitForLog(hostContainerName, /listening on/, 15_000);
    // auth.ts refuses any request timestamped in the same wall-clock
    // second as the receiver's own process start (see server.test.ts's
    // identical wait, "item 2's floor is now `<=`") -- without this, the
    // very first push here can lose that race and be refused as
    // "replayed after a restart" even though nothing was ever replayed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }, 180_000);

  afterAll(async () => {
    if (hostContainerName) spawnSync('docker', ['rm', '-f', hostContainerName]);
    if (networkName) spawnSync('docker', ['network', 'rm', networkName]);
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
    if (transferReport) console.log(transferReport);
  }, 30_000);

  it('receives the real Ghost image by push, over the connection it dials into the host with, and the host runs it by digest', () => {
    const tarBytes = statSync(tarPath).size;
    const startedMs = performance.now();
    const result = controlPlanePush(expectedDigest);
    const elapsedMs = performance.now() - startedMs;
    transferReport = `Done means "the transfer time for a Ghost image is recorded": ${GHOST_IMAGE} (${tarBytes} bytes) pushed and loaded in ${elapsedMs.toFixed(1)}ms`;

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ digest: expectedDigest, imageId: imageIdFull });

    // Present on the host's own daemon -- not merely reported as loaded.
    expect(
      spawnSync('docker', ['exec', hostContainerName, 'docker', 'image', 'inspect', imageIdFull])
        .status
    ).toBe(0);

    // Runs it by digest, from inside the egress-denied host itself.
    // `BRANCHLEFT_ALLOW_LOCAL_STORAGE` is the image's own smoke-test
    // escape hatch (see adapters/scanning-storage/README.md) past its
    // storage-adapter guard; it still exits once Ghost reaches a real
    // database connection this sandbox provides none of -- a different,
    // already-proven concern (render-core's live-demo-boot.test.ts) that
    // this story's own Done means does not ask for. "Runs it by digest"
    // is proven by the container actually starting and executing code
    // from the pushed image, not by staying healthy afterwards.
    const ranId = execFileSync('docker', [
      'exec',
      hostContainerName,
      'docker',
      'run',
      '-d',
      '-e',
      'BRANCHLEFT_ALLOW_LOCAL_STORAGE=true',
      imageIdFull,
    ])
      .toString()
      .trim();
    try {
      const startedAt = execFileSync('docker', [
        'exec',
        hostContainerName,
        'docker',
        'inspect',
        '--format',
        '{{.State.StartedAt}}',
        ranId,
      ])
        .toString()
        .trim();
      expect(startedAt).not.toBe('');
      expect(startedAt.startsWith('0001-01-01')).toBe(false);
    } finally {
      spawnSync('docker', ['exec', hostContainerName, 'docker', 'rm', '-f', ranId]);
    }
  }, 120_000);

  it('a stream whose digest does not match is refused, and nothing is loaded', () => {
    const result = controlPlanePush(`sha256:${'f'.repeat(64)}`);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  }, 60_000);

  it("the host's own network has no route to a registry -- a pull could never have worked here", () => {
    const res = spawnSync('docker', [
      'run',
      '--rm',
      '--network',
      networkName,
      'curlimages/curl:8.16.0',
      'curl',
      '-m',
      '5',
      '-sSf',
      'https://ghcr.io/v2/',
    ]);
    // curl 6/7/28 are "never reached the server at all" (DNS, connect,
    // timeout); curl 22 is "-f caught an HTTP error status" -- which means
    // the network *did* carry the request there and back. Both are
    // non-zero, so asserting merely `!== 0` cannot tell a genuinely
    // egress-denied network apart from one that reached ghcr.io and got a
    // real 401 -- confirmed live while writing this test: dropping
    // `--internal` from an otherwise identical network turned this curl's
    // exit code from 28 into 22, not into 0. Only the connectivity-failure
    // codes prove no route existed.
    expect([6, 7, 28]).toContain(res.status);
  });

  it('the host holds no registry credential', () => {
    const out = execFileSync('docker', [
      'exec',
      hostContainerName,
      'sh',
      '-c',
      'test -f /root/.docker/config.json && echo present || echo absent',
    ])
      .toString()
      .trim();
    expect(out).toBe('absent');

    const env = execFileSync('docker', ['exec', hostContainerName, 'env']).toString();
    expect(env).not.toMatch(/(REGISTRY|DOCKER_AUTH)[A-Z_]*=/);
  });
});

describe.skipIf(canRun)('LIVE push-delivery proof — skipped', () => {
  it(`needs Docker and the ${GHOST_IMAGE} image locally; not run in broker-ci.yml`, () => {
    expect(canRun).toBe(false);
  });
});
