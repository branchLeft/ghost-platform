/**
 * One-shot entry: sends the signed `POST /reconcile` for a descriptor file to
 * the broker (through the owner's tunnel) and prints the status and body. Exit
 * 0 only on a 200. Environment wiring only, so it is excluded from coverage
 * like server.ts; the logic is in reconcileRequest.ts.
 *
 * Reads: BROKER_BASE_URL (loopback, e.g. http://127.0.0.1:8090 through the
 * tunnel), PUSH_KEY_PATH (the raw 32-byte Ed25519 signing key), DESCRIPTOR_FILE,
 * and SLOT (default 0).
 */
import { readFile } from 'node:fs/promises';
import type { TenantDescriptor } from '@branchleft/ghost-platform-render-core';
import { signedReconcileRequest } from './reconcileRequest.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const baseUrl = required('BROKER_BASE_URL');
const privateKeyRaw = await readFile(required('PUSH_KEY_PATH'));
const descriptor = JSON.parse(
  await readFile(required('DESCRIPTOR_FILE'), 'utf8')
) as TenantDescriptor;
const slot = process.env['SLOT'] ?? '0';

const { body, headers } = signedReconcileRequest({ slot, descriptor, privateKeyRaw });
const response = await fetch(`${baseUrl}/reconcile`, {
  method: 'POST',
  body,
  headers,
  redirect: 'manual',
  signal: AbortSignal.timeout(15 * 60 * 1000),
});
const text = await response.text();
process.stdout.write(`${JSON.stringify({ status: response.status, body: text })}\n`);
process.exit(response.status === 200 ? 0 : 1);
