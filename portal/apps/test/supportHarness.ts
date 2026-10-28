import type { HealthView } from 'ghost-platform-portal-data/tenant';
import type { SupportMailer, SupportMessage } from '../src/tenant/supportMailer.js';

export const FAKE_RECIPIENT = 'support-inbox@example.org';
export const FAKE_SENDER = 'portal-sender@example.org';
export const FAKE_CONTACT = 'tenant-admin@example.com';

/** An in-memory mailer: records what it is given, or fails when told to. */
export class RecordingMailer implements SupportMailer {
  readonly sent: SupportMessage[] = [];
  failure: Error | null = null;

  async send(message: SupportMessage): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.sent.push(message);
  }
}

export function reading(overrides: Partial<HealthView> = {}): HealthView {
  return {
    health: 'healthy',
    reportedVersion: '6.55.0',
    versionMatch: true,
    mismatchSince: null,
    observedAt: new Date('2026-10-01T10:00:00.000Z'),
    ...overrides,
  };
}

export function formOf(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}
