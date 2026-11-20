/**
 * The owner's copy of a demo's viewing passphrase (LLD-12 section 03): sent to
 * the owner's own address at the moment the prospect's arrival mail is about
 * to be sent, so the owner never has to ask for it. The address is the one
 * `OWNER_DUE_DILIGENCE_EMAIL` setting and appears nowhere else. See
 * controlPlaneDemoOwnerCopy.md.
 */
import type { EmailAddress } from '@branchleft/ghost-platform-render-core';
import { assertOwnerDueDiligenceEmail } from './ownerDueDiligence.js';

/** One plain-text message to one address, over whatever mail path the control plane uses. */
export interface OwnerMailer {
  send(mail: {
    readonly to: EmailAddress;
    readonly subject: string;
    readonly text: string;
  }): Promise<void>;
}

/** What a LIVE provision outcome carries that the owner needs. */
export interface LiveDemoForOwner {
  readonly hostname: string;
  readonly slot: string;
  readonly expiresAt: Date;
  readonly passphrase: string;
}

export interface OwnerCopyDeps {
  readonly mailer: OwnerMailer;
  /** `OWNER_DUE_DILIGENCE_EMAIL`, as read by `ownerDueDiligenceEmailFromEnv`. */
  readonly ownerEmail: EmailAddress;
  /** Reason codes only: never a passphrase or an address. */
  readonly log: (line: string) => void;
}

/**
 * Sends the owner the passphrase. Call it BEFORE the prospect's arrival mail
 * and send that mail only when this returns: a failure here throws, so a
 * prospect is never given a passphrase the owner does not also hold.
 *
 * @throws OwnerDueDiligenceUnsetError when the address is missing or invalid; nothing is sent
 * @throws Error when the mailer fails (the cause is not copied: it may echo the mail)
 */
export async function copyPassphraseToOwner(
  deps: OwnerCopyDeps,
  demo: LiveDemoForOwner
): Promise<void> {
  const to = assertOwnerDueDiligenceEmail(deps.ownerEmail);
  if (demo.passphrase === '') throw new Error('owner copy: the demo has no passphrase to send');
  try {
    await deps.mailer.send({
      to,
      subject: `Demo ${demo.hostname}: viewing passphrase`,
      text: [
        `Demo: ${demo.hostname}`,
        `Slot: ${demo.slot}`,
        `Expires: ${demo.expiresAt.toISOString()}`,
        `Viewing passphrase: ${demo.passphrase}`,
        '',
        'You are a reader of this demo, not an administrator.',
      ].join('\n'),
    });
  } catch {
    deps.log(`owner copy: slot ${demo.slot} not sent (mailer failed)`);
    throw new Error(`owner copy for slot ${demo.slot} was not sent`);
  }
  deps.log(`owner copy: slot ${demo.slot} sent`);
}
