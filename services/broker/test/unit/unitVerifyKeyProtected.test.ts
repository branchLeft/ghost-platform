import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_PATH = join(HERE, '../../systemd/branchleft-broker.service');
const DOCKERFILE_PATH = join(HERE, '../live/fixtures/systemd-boot/Dockerfile');
const RUNBOOK_PATH = join(HERE, '../../RUNBOOK-broker-deploy.md');
const VERIFY_KEY_PATH = '/etc/branchleft/broker-verify-key.bin';

/**
 * The verify key is the broker's request-signing trust anchor: readable by
 * the broker account (config.ts#loadConfig opens it directly), never
 * writable by it -- see systemd/README.md ("The verify key").
 */
describe('the verify key is read-only to the broker process', () => {
  it('the unit lists it under ReadOnlyPaths', () => {
    const unit = readFileSync(UNIT_PATH, 'utf8');
    const match = /^ReadOnlyPaths=(.*)$/m.exec(unit);
    expect(match).not.toBeNull();
    expect((match?.[1] ?? '').split(/\s+/)).toContain(VERIFY_KEY_PATH);
  });

  it('the boot-proof fixture installs it root:broker 0640, not broker:broker 0600', () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
    expect(dockerfile).toContain(`chown root:broker ${VERIFY_KEY_PATH}`);
    expect(dockerfile).toContain(`chmod 0640 ${VERIFY_KEY_PATH}`);
    expect(dockerfile).not.toContain(`chown broker:broker ${VERIFY_KEY_PATH}`);
  });

  it('the runbook documents root:broker, mode 0640', () => {
    const runbook = readFileSync(RUNBOOK_PATH, 'utf8');
    expect(runbook).toContain('root:broker');
    expect(runbook).toContain('0640');
    expect(runbook).not.toContain('broker:broker`, mode 0600');
  });
});
