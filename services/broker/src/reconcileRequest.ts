/**
 * Builds the signed `POST /reconcile` a lease sends. The signed bytes are the raw JSON body, so the
 * body is serialised once here and signed as those exact bytes.
 */
import { randomBytes } from 'node:crypto';
import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import { signRequest } from './signing.js';

export const RECONCILE_PATH = '/reconcile';

export interface SignedReconcileArgs {
  readonly slot: string;
  readonly descriptor: TenantDescriptor;
  readonly privateKeyRaw: Buffer;
  readonly nowSeconds?: number;
  readonly nonce?: string;
}

export interface SignedReconcile {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

export function signedReconcileRequest(args: SignedReconcileArgs): SignedReconcile {
  const body = Buffer.from(
    JSON.stringify({ slot: args.slot, descriptor: args.descriptor }),
    'utf8'
  );
  const timestamp = String(args.nowSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = args.nonce ?? randomBytes(16).toString('hex');
  const signature = signRequest(args.privateKeyRaw, 'POST', RECONCILE_PATH, timestamp, nonce, body);
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'X-Broker-Timestamp': timestamp,
      'X-Broker-Nonce': nonce,
      'X-Broker-Signature': signature,
    },
  };
}
