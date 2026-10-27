/** One plain-text email, every header value already checked for line breaks and NUL. */
export interface SupportMessage {
  readonly to: string;
  readonly from: string;
  readonly replyTo: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * The outside dependency that delivers a support ticket. The tenant portal
 * defines the port and never chooses a transport; whoever builds the portal
 * injects an implementation. A rejection means the message was not sent.
 */
export interface SupportMailer {
  send(message: SupportMessage): Promise<void>;
}

/** What `createTenantPortal` needs to offer support tickets; absent, there are none. */
export interface SupportSettings {
  readonly mailer: SupportMailer;
  /** Where tickets go. An injected value, never a literal in source. */
  readonly recipient: string;
  /** The address tickets are sent from. An injected value, never a literal in source. */
  readonly sender: string;
}
