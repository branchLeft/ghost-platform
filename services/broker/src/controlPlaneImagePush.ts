/**
 * The control-plane caller for `pushImage` (controlPlanePush.ts), generic
 * over the image reference. It keeps two facts apart:
 *
 * - Provenance: the GHCR manifest digest. Before anything is pulled the
 *   attestation for that digest must verify against the expected signer
 *   workflow; after the pull the local image must report that same digest.
 * - Transport integrity: the sha256 of the `docker save` bytes this caller
 *   produced. That hash is what it declares to `pushImage`, and the receiver
 *   checks the bytes it gets against it, as it already does. Nothing pins a
 *   tar hash in config, because `docker save` output is not guaranteed
 *   reproducible.
 *
 * The docker and attestation calls sit behind `ImageProvenanceDeps` so the
 * refusals are testable without a registry; `realProvenanceDeps` is the
 * production wiring (argv only, never a shell).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { type PushImageResult, pushImage } from './controlPlanePush.js';

const run = promisify(execFile);

/** Only GHCR images of this org, with no tag and no digest in the ref. */
const IMAGE_REF_PATTERN = /^ghcr\.io\/branchleft\/[a-z0-9][a-z0-9._-]*$/;
const MANIFEST_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface ImageProvenanceDeps {
  /** True only when `gh attestation verify` accepts `ref` from `signerWorkflow` on main. */
  verifyAttestation(ref: string, signerWorkflow: string): Promise<boolean>;
  /** Pulls `name@sha256:...`; the engine verifies the content against that digest. */
  pull(ref: string): Promise<void>;
  /** The RepoDigests the local engine reports for `ref`. */
  repoDigests(ref: string): Promise<readonly string[]>;
  /** Writes `docker save <ref>` to `tarPath`. */
  save(ref: string, tarPath: string): Promise<void>;
}

export interface PushOciImageArgs {
  readonly imageRef: string;
  readonly manifestDigest: string;
  readonly signerWorkflow: string;
  readonly baseUrl: string;
  readonly privateKeyRaw: Buffer;
  readonly tarPath: string;
  readonly deps: ImageProvenanceDeps;
  readonly nowSeconds?: number;
}

export interface PushOciImageResult {
  /** The sha256 this caller computed over the tar and declared to the receiver. */
  readonly tarDigest: string;
  readonly push: PushImageResult;
}

export class ImageRefusedError extends Error {
  constructor(reason: string) {
    super(`refused: ${reason}`);
    this.name = 'ImageRefusedError';
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function pushOciImage(args: PushOciImageArgs): Promise<PushOciImageResult> {
  if (!IMAGE_REF_PATTERN.test(args.imageRef)) {
    throw new ImageRefusedError(
      `image ref ${args.imageRef} is not a ghcr.io/branchleft/<name> ref`
    );
  }
  if (!MANIFEST_DIGEST_PATTERN.test(args.manifestDigest)) {
    throw new ImageRefusedError('manifest digest is not sha256:<64 lowercase hex>');
  }

  const ref = `${args.imageRef}@${args.manifestDigest}`;
  const { deps } = args;

  if (!(await deps.verifyAttestation(ref, args.signerWorkflow))) {
    throw new ImageRefusedError(
      `unattested: ${ref} has no valid attestation from ${args.signerWorkflow}`
    );
  }

  await deps.pull(ref);

  const digests = await deps.repoDigests(ref);
  if (!digests.includes(ref)) {
    throw new ImageRefusedError(
      `pulled image is not the declared manifest digest ${args.manifestDigest}`
    );
  }

  await deps.save(ref, args.tarPath);
  const tarDigest = await sha256File(args.tarPath);

  const push = await pushImage({
    baseUrl: args.baseUrl,
    digest: tarDigest,
    tarPath: args.tarPath,
    privateKeyRaw: args.privateKeyRaw,
    ...(args.nowSeconds === undefined ? {} : { nowSeconds: args.nowSeconds }),
  });
  return { tarDigest, push };
}

/** Repo the attestation must name; the verify script fixes its own identity flags. */
const ATTESTED_REPO = 'branchLeft/ghost-platform';

export interface RealProvenanceOptions {
  /** Path to `scripts/verify-image-attestation.sh` in a checkout of ATTESTED_REPO. */
  readonly verifyScript: string;
}

/**
 * Production wiring. Every call is an argv list; no shell. The verify script
 * is the repo's own authority, so this does not restate its flags.
 */
export function realProvenanceDeps(options: RealProvenanceOptions): ImageProvenanceDeps {
  return {
    async verifyAttestation(ref, signerWorkflow) {
      try {
        await run(options.verifyScript, [ref, ATTESTED_REPO, signerWorkflow]);
        return true;
      } catch {
        return false;
      }
    },
    async pull(ref) {
      await run('docker', ['pull', ref]);
    },
    async repoDigests(ref) {
      const { stdout } = await run('docker', [
        'image',
        'inspect',
        '--format',
        '{{json .RepoDigests}}',
        ref,
      ]);
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'string')) {
        throw new ImageRefusedError('docker inspect did not return a RepoDigests string array');
      }
      return parsed;
    },
    async save(ref, tarPath) {
      await run('docker', ['save', '-o', tarPath, ref]);
    },
  };
}
