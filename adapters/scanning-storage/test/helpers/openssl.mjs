// The independent reference for certificate work: the openssl binary, when the
// machine has one. A test that needs it skips cleanly when it is absent.
import { spawnSync } from 'node:child_process';

export const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

export function runOpenssl(args, input) {
  const result = spawnSync('openssl', args, { input });
  if (result.status !== 0) {
    throw new Error(`openssl ${args.join(' ')} failed: ${result.stderr?.toString()}`);
  }
  return result.stdout.toString();
}

// SHA-256 of the SubjectPublicKeyInfo DER, by the recipe a person would type.
export function opensslPin(certificatePem) {
  const spki = spawnSync('openssl', ['x509', '-pubkey', '-noout'], { input: certificatePem });
  const der = spawnSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: spki.stdout });
  const digest = spawnSync('openssl', ['dgst', '-sha256', '-hex'], { input: der.stdout });
  return digest.stdout.toString().trim().split(' ').pop();
}
