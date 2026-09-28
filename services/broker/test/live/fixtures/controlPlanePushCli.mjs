// The control-plane side of imagePush.live.test.ts, run as a one-shot
// container attached to the *same* `--internal` (no-egress) network as the
// host. It dials into the host by the host container's own name -- Docker's
// embedded DNS resolves that on a user-defined network regardless of
// `--internal` -- rather than through a published port: Docker Desktop does
// not forward a published port into a container on an internal network,
// which is exactly the "this is inbound to the host, not outbound from it"
// property `--internal` exists to prove. It never imports `docker` or a
// registry client of any kind, only this service's own real `pushImage`.
import { readFileSync } from 'node:fs';
import { pushImage } from '/app/dist/controlPlanePush.js';

const baseUrl = process.env.PUSH_BASE_URL;
const digest = process.env.PUSH_DIGEST;
const tarPath = process.env.PUSH_TAR_PATH;
const privateKeyRaw = readFileSync(process.env.PUSH_KEY_PATH);

const result = await pushImage({ baseUrl, digest, tarPath, privateKeyRaw });
process.stdout.write(`${JSON.stringify(result)}\n`);
// Always 0: a refused push (a wrong digest, a bad signature) is this
// script's *expected*, correctly reported outcome, not a script failure --
// the caller reads the JSON line above to tell the two apart.
process.exit(0);
