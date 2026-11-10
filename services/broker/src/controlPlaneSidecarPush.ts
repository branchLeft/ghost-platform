/**
 * The control-plane call site that delivers the demo drain sidecar to a
 * host: it fixes the two facts only this image has (its GHCR name and the
 * workflow that must have attested it) and hands the rest to `pushOciImage`.
 * Narrative: controlPlaneSidecarPush.md.
 */
import { readFile } from 'node:fs/promises';
import { type ImageProvenanceDeps, type PushOciImageResult, pushOciImage } from './controlPlaneImagePush.js';

export const SIDECAR_IMAGE_REF = 'ghcr.io/branchleft/drain-sidecar';
export const SIDECAR_SIGNER_WORKFLOW = 'branchLeft/ghost-platform/.github/workflows/drain-sidecar-image.yml';
/** The variable the colour unit reads from the host's sidecar image env file. */
export const SIDECAR_IMAGE_VARIABLE = 'DEMO_SIDECAR_IMAGE';

export interface SidecarPushEnv {
  readonly manifestDigest: string;
  readonly baseUrl: string;
  readonly keyPath: string;
  readonly tarPath: string;
}

export interface SidecarPushOutcome extends PushOciImageResult {
  /** The one line the host's sidecar image env file must hold; only set when the host accepted the image. */
  readonly envLine: string | undefined;
}

export class SidecarPushConfigError extends Error {
  constructor(name: string) {
    super(`${name} is not set`);
    this.name = 'SidecarPushConfigError';
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new SidecarPushConfigError(name);
  }
  return value;
}

export function sidecarPushEnv(env: Readonly<Record<string, string | undefined>>): SidecarPushEnv {
  return {
    manifestDigest: required(env, 'SIDECAR_MANIFEST_DIGEST'),
    baseUrl: required(env, 'PUSH_BASE_URL'),
    keyPath: required(env, 'PUSH_KEY_PATH'),
    tarPath: required(env, 'PUSH_TAR_PATH'),
  };
}

export async function pushDemoSidecar(
  config: SidecarPushEnv,
  deps: ImageProvenanceDeps,
  nowSeconds?: number
): Promise<SidecarPushOutcome> {
  const privateKeyRaw = await readFile(config.keyPath);
  const result = await pushOciImage({
    imageRef: SIDECAR_IMAGE_REF,
    manifestDigest: config.manifestDigest,
    signerWorkflow: SIDECAR_SIGNER_WORKFLOW,
    baseUrl: config.baseUrl,
    privateKeyRaw,
    tarPath: config.tarPath,
    deps,
    ...(nowSeconds === undefined ? {} : { nowSeconds }),
  });
  const envLine = result.push.ok
    ? `${SIDECAR_IMAGE_VARIABLE}=${SIDECAR_IMAGE_REF}@${config.manifestDigest}`
    : undefined;
  return { ...result, envLine };
}
