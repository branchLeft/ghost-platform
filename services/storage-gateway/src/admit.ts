import type {
  AllowedOperation,
  CredentialStore,
  GatewayRequest,
  Refusal,
  RefusalCode,
  SignatureVerifier,
} from './contracts.js';
import { refusal } from './refusal.js';
import { guardTenant, routeRequest, type RoutedRequest } from './router.js';

/** One logged refusal. Carries no object key, bucket or request target. */
export interface RefusalLogEntry {
  readonly event: 'request-refused';
  readonly code: RefusalCode;
  readonly status: number;
  readonly method: string;
  /** The tenant's key id; absent when the request never reached a verified identity. */
  readonly keyId?: string;
  /** The tenant's opaque folder; absent until the credential was looked up. */
  readonly folder?: string;
  /** The operation named, when the request got as far as being routed. */
  readonly operation?: AllowedOperation;
}

export interface GatewayLogger {
  refusal(entry: RefusalLogEntry): void;
}

export interface AdmitDependencies {
  readonly verifier: SignatureVerifier;
  readonly credentials: CredentialStore;
  readonly logger: GatewayLogger;
}

export type AdmitResult =
  | {
      readonly ok: true;
      readonly route: RoutedRequest;
      readonly tenant: { readonly keyId: string; readonly folder: string; readonly bucket: string };
    }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * Decides whether a request may be forwarded upstream, failing closed. The
 * order is: who signed it, whether that credential is active, whether the
 * request is one of the allowed shapes, and whether it stays inside the
 * tenant's bucket and folder. Every refusal is logged with the tenant, when
 * one is known, and a verifier or store that throws is a refusal, never a pass.
 */
export async function admit(
  request: GatewayRequest,
  deps: AdmitDependencies
): Promise<AdmitResult> {
  const method = request.method;
  const refuse = (
    code: RefusalCode,
    context: { keyId?: string; folder?: string; operation?: AllowedOperation } = {}
  ): AdmitResult => {
    const r = refusal(code);
    deps.logger.refusal({
      event: 'request-refused',
      code,
      status: r.status,
      method,
      ...(context.keyId === undefined ? {} : { keyId: context.keyId }),
      ...(context.folder === undefined ? {} : { folder: context.folder }),
      ...(context.operation === undefined ? {} : { operation: context.operation }),
    });
    return { ok: false, refusal: r };
  };

  let keyId: string;
  try {
    const verified = await deps.verifier.verify(request);
    if (verified.ok !== true) return refuse(verified.refusal.code);
    if (typeof verified.keyId !== 'string' || verified.keyId === '')
      return refuse('internal-error');
    keyId = verified.keyId;
  } catch {
    return refuse('internal-error');
  }

  let credential;
  try {
    credential = await deps.credentials.lookup(keyId);
  } catch {
    return refuse('internal-error', { keyId });
  }
  // An unknown key id answers exactly as a bad signature does, so a caller
  // cannot probe which key ids exist.
  if (credential === undefined) return refuse('signature-refused', { keyId });
  const folder = credential.folder;
  if (credential.state !== 'active') return refuse('credential-not-active', { keyId, folder });

  const routed = routeRequest(request);
  if (!routed.ok) return refuse(routed.refusal.code, { keyId, folder });

  const denied = guardTenant(routed.route, credential);
  if (denied !== undefined) {
    return refuse(denied.code, { keyId, folder, operation: routed.route.operation });
  }

  return { ok: true, route: routed.route, tenant: { keyId, folder, bucket: credential.bucket } };
}
