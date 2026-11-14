/**
 * The control-plane call site that delivers the demo slot's Ghost image to a
 * host: it fixes the two facts only this image has (its GHCR name and the
 * workflow that must have attested it) and hands the rest to `pushOciImage`.
 * Narrative: controlPlaneSlotImagePush.md.
 */
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ImageProvenanceDeps,
  type PushOciImageResult,
  pushOciImage,
} from './controlPlaneImagePush.js';

export const SLOT_IMAGE_REF = 'ghcr.io/branchleft/ghost-tenant';
export const SLOT_IMAGE_SIGNER_WORKFLOW =
  'branchLeft/ghost-platform/.github/workflows/registry-push.yml';

export interface SlotImagePushEnv {
  readonly manifestDigest: string;
  readonly baseUrl: string;
  readonly keyPath: string;
}

export interface SlotImagePushOutcome extends PushOciImageResult {
  /** The `name@digest` a slot's descriptor must pin; only set when the host accepted the image. */
  readonly imageRef: string | undefined;
}

export class SlotImagePushConfigError extends Error {
  constructor(name: string) {
    super(`${name} is not set`);
    this.name = 'SlotImagePushConfigError';
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new SlotImagePushConfigError(name);
  }
  return value;
}

export function slotImagePushEnv(
  env: Readonly<Record<string, string | undefined>>
): SlotImagePushEnv {
  return {
    manifestDigest: required(env, 'SLOT_IMAGE_MANIFEST_DIGEST'),
    baseUrl: required(env, 'PUSH_BASE_URL'),
    keyPath: required(env, 'PUSH_KEY_PATH'),
  };
}

export async function pushDemoSlotImage(
  config: SlotImagePushEnv,
  deps: ImageProvenanceDeps,
  nowSeconds?: number
): Promise<SlotImagePushOutcome> {
  const privateKeyRaw = await readFile(config.keyPath);
  // A fresh owner-only directory, and in it a file created with `wx`, so the
  // tar is never written through a path or a link that already existed.
  const dir = await mkdtemp(join(tmpdir(), 'slot-image-push-'));
  try {
    const tarPath = join(dir, 'image.tar');
    await (await open(tarPath, 'wx', 0o600)).close();
    const result = await pushOciImage({
      imageRef: SLOT_IMAGE_REF,
      manifestDigest: config.manifestDigest,
      signerWorkflow: SLOT_IMAGE_SIGNER_WORKFLOW,
      baseUrl: config.baseUrl,
      privateKeyRaw,
      tarPath,
      deps,
      ...(nowSeconds === undefined ? {} : { nowSeconds }),
    });
    const imageRef = hostConfirmed(result)
      ? `${SLOT_IMAGE_REF}@${config.manifestDigest}`
      : undefined;
    return { ...result, imageRef };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The host accepted the push and its reply names the digest of the tar this
 * caller sent. A bare 2xx is not enough: the reply body is what the receiver
 * wrote after checking and loading the bytes.
 */
function hostConfirmed(result: PushOciImageResult): boolean {
  const { body } = result.push;
  return (
    result.push.ok &&
    typeof body === 'object' &&
    body !== null &&
    'digest' in body &&
    body.digest === result.tarDigest
  );
}
