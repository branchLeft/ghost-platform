// Build-time only (Dockerfile): generates a throwaway Ed25519 keypair for
// this proof image alone, writes the 32 raw public-key bytes
// `BROKER_VERIFY_KEY_FILE` needs (`config.ts#loadConfig` refuses anything
// else) to argv[2], and the 32 raw private-key bytes the proof's own
// signing script needs to argv[3]. Never used outside this fixture -- a
// real install generates its own key pair out of band and ships only the
// public half to the host.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [, , publicOut, privateOut] = process.argv;
if (!publicOut || !privateOut) {
  console.error('usage: make-verify-key.mjs <public-out> <private-out>');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(publicOut, publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
writeFileSync(privateOut, privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16));
