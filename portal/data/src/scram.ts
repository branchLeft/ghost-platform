import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 4096;

/**
 * A PostgreSQL SCRAM-SHA-256 verifier for `password`, the value `psql
 * \\password` would send. Passwords are limited to printable ASCII because the
 * server normalises anything else with SASLprep, which is not implemented here.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[\x20-\x7e]+$/.test(password)) {
    throw new Error('a login password must be printable ASCII');
  }
  const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const hmac = (key: Buffer, data: string): Buffer =>
    createHmac('sha256', key).update(data).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  const b64 = (buffer: Buffer): string => buffer.toString('base64');
  return `SCRAM-SHA-256$${ITERATIONS}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}
