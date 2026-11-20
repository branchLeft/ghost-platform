import { describe, expect, it } from 'vitest';
import type { EmailAddress } from '@branchleft/ghost-platform-render-core';
import { copyPassphraseToOwner, type OwnerMailer } from '../../src/controlPlaneDemoOwnerCopy.js';
import { OwnerDueDiligenceUnsetError } from '../../src/ownerDueDiligence.js';

const OWNER = 'owner-review@example.invalid' as EmailAddress;
const PASSPHRASE = 'plum-river-ladder-47';
const DEMO = {
  hostname: 'k7m-vale-bright.demo-domain.example.test',
  slot: '3',
  expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  passphrase: PASSPHRASE,
};

function rig(mailer?: Partial<OwnerMailer>) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const log: string[] = [];
  const full: OwnerMailer = {
    send: async (mail) => {
      sent.push(mail);
    },
    ...mailer,
  };
  return { sent, log, deps: { mailer: full, ownerEmail: OWNER, log: (l: string) => log.push(l) } };
}

describe('the owner receives the viewing passphrase', () => {
  it('sends it to the owner address with the demo it opens and when it ends', async () => {
    const { sent, deps } = rig();
    await copyPassphraseToOwner(deps, DEMO);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(OWNER);
    expect(sent[0]?.text).toContain(PASSPHRASE);
    expect(sent[0]?.text).toContain(DEMO.hostname);
    expect(sent[0]?.text).toContain('2026-12-01T00:00:00.000Z');
  });

  it('logs neither the passphrase nor the address', async () => {
    const { log, deps } = rig();
    await copyPassphraseToOwner(deps, DEMO);
    expect(log.length).toBeGreaterThan(0);
    for (const line of log) {
      expect(line).not.toContain(PASSPHRASE);
      expect(line).not.toContain('example.invalid');
    }
  });

  it('throws when the mailer fails, so the prospect mail that follows is not sent, and leaks nothing', async () => {
    const { log, deps } = rig({
      send: async () => {
        throw new Error(`smtp said no to ${OWNER} about ${PASSPHRASE}`);
      },
    });
    const failure = await copyPassphraseToOwner(deps, DEMO).then(
      () => undefined,
      (err: Error) => err
    );
    expect(failure?.message).toBe('owner copy for slot 3 was not sent');
    for (const text of [failure?.message ?? '', ...log]) {
      expect(text).not.toContain(PASSPHRASE);
      expect(text).not.toContain('example.invalid');
    }
  });

  it('sends nothing when the address is unset', async () => {
    const { sent, deps } = rig();
    await expect(
      copyPassphraseToOwner({ ...deps, ownerEmail: '' as EmailAddress }, DEMO)
    ).rejects.toThrow(OwnerDueDiligenceUnsetError);
    expect(sent).toEqual([]);
  });

  it('refuses a demo with no passphrase to send', async () => {
    const { sent, deps } = rig();
    await expect(copyPassphraseToOwner(deps, { ...DEMO, passphrase: '' })).rejects.toThrow(
      /no passphrase/
    );
    expect(sent).toEqual([]);
  });
});
