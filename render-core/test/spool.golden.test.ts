// Pins the rendered demo1 mail-spool Compose file byte for byte: a host role
// fetches the golden at a pinned sha. The image digest has one home, the
// SPOOL_IMAGE default in scripts/test-demo-mail-spool.sh, read from there.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DigestPinnedRef, Port, TenantUid } from '../src/brand.js';
import { renderMailSpoolStack } from '../src/spool.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPOOL_PROOF_SCRIPT = join(here, '..', '..', 'scripts', 'test-demo-mail-spool.sh');
const GOLDEN = join(here, 'golden', 'mail-spool-compose.demo1.yml');

const DRAIN_PORT = 8095 as Port;
const DEMO_SLOT_UIDS = [30001, 30002, 30003, 30004, 30005, 30006, 30007] as TenantUid[];

function proofImage(): DigestPinnedRef {
  const match = /^SPOOL_IMAGE="\$\{SPOOL_IMAGE:-([^}"]+)\}"$/m.exec(
    readFileSync(SPOOL_PROOF_SCRIPT, 'utf-8')
  );
  if (!match) {
    throw new Error('scripts/test-demo-mail-spool.sh no longer has a SPOOL_IMAGE default');
  }
  return match[1] as DigestPinnedRef;
}

describe('the demo1 mail-spool Compose file', () => {
  it('names the digest-pinned image the spool CI proof runs', () => {
    expect(proofImage()).toMatch(/^ghcr\.io\/branchleft\/mailgun-shim@sha256:[0-9a-f]{64}$/);
  });

  it('is rendered byte for byte as the committed golden file', () => {
    const rendered = renderMailSpoolStack({
      image: proofImage(),
      uids: DEMO_SLOT_UIDS,
      drainPort: DRAIN_PORT,
    });
    expect(rendered).toBe(readFileSync(GOLDEN, 'utf-8'));
  });
});
