/**
 * One-shot control-plane entry: pushes the pinned demo sidecar digest to one
 * host and prints a JSON line. Environment wiring only, so it is excluded
 * from coverage like server.ts; the logic is in controlPlaneSidecarPush.ts.
 */
import { realProvenanceDeps } from './controlPlaneImagePush.js';
import { pushDemoSidecar, sidecarPushEnv } from './controlPlaneSidecarPush.js';

const verifyScript = process.env['VERIFY_SCRIPT'];
if (verifyScript === undefined || verifyScript === '') {
  throw new Error('VERIFY_SCRIPT is not set');
}
const outcome = await pushDemoSidecar(sidecarPushEnv(process.env), realProvenanceDeps({ verifyScript }));
process.stdout.write(`${JSON.stringify(outcome)}\n`);
process.exit(outcome.push.ok ? 0 : 1);
