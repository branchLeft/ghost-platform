/**
 * What the journey runs against. `dist` starts the two applications from the
 * built `dist/` of this checkout (what a pull request can test); `image`
 * starts them from the pushed, attested image, named by digest. The test code,
 * the identity provider, the provisioning mock and the mail double are the same
 * either way and always run on the test host.
 */
export type Target =
  { readonly kind: 'dist' } | { readonly kind: 'image'; readonly reference: string };

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

/** `registry/name@sha256:<64 lowercase hex>`: the form scripts/verify-image-attestation.sh accepts. */
const DIGEST_REFERENCE =
  /^[a-z0-9][a-z0-9.-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

/**
 * The target named by `JOURNEY_IMAGE`: unset or blank is the built checkout.
 * An image is refused unless it is named by digest, because a tag can move
 * after the attestation was checked, so a tag proves nothing about what runs.
 */
export function targetFromEnv(env: Readonly<Record<string, string | undefined>>): Target {
  const reference = env['JOURNEY_IMAGE'];
  if (reference === undefined || reference.trim() === '') return { kind: 'dist' };
  if (!DIGEST_REFERENCE.test(reference.trim())) {
    throw new TargetError(
      'JOURNEY_IMAGE must name an image by digest (registry/name@sha256:<64 hex>)'
    );
  }
  return { kind: 'image', reference: reference.trim() };
}
