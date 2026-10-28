import { parsePort, readText, type FileReader } from '../shell/config.js';
import type { SupportSettings } from './supportMailer.js';
import {
  createSmtpSupportMailer,
  type SmtpSecurity,
  type SupportMailerErrorCode,
} from './supportSmtpMailer.js';
import { assertHeaderValue, validateContact } from './supportValidation.js';

type Env = Readonly<Record<string, string | undefined>>;

export const SUPPORT_VARIABLES = {
  host: 'PORTAL_SUPPORT_SMTP_HOST',
  port: 'PORTAL_SUPPORT_SMTP_PORT',
  security: 'PORTAL_SUPPORT_SMTP_SECURITY',
  user: 'PORTAL_SUPPORT_SMTP_USER',
  passwordFile: 'PORTAL_SUPPORT_SMTP_PASSWORD_FILE',
  sender: 'PORTAL_SUPPORT_SENDER',
  recipient: 'PORTAL_SUPPORT_RECIPIENT',
} as const;

export interface SupportLoad {
  /** Absent when anything is missing or invalid: the support routes then answer 404. */
  readonly support: SupportSettings | undefined;
  /** Variable names only, never a value. */
  readonly disabledBecause: readonly string[];
}

const DEFAULT_PORT = 587;

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function address(value: string | undefined): string | undefined {
  if (!present(value)) return undefined;
  try {
    assertHeaderValue(value);
    return validateContact(value);
  } catch {
    return undefined;
  }
}

function portOf(value: string | undefined): number | undefined {
  try {
    return parsePort(value, DEFAULT_PORT);
  } catch {
    return undefined;
  }
}

function securityOf(value: string | undefined): SmtpSecurity | undefined {
  if (value === undefined) return 'STARTTLS';
  return value === 'STARTTLS' || value === 'IMPLICIT' ? value : undefined;
}

function passwordFrom(env: Env, read: FileReader): string | undefined {
  const path = env[SUPPORT_VARIABLES.passwordFile];
  if (!present(path)) return undefined;
  try {
    const password = read(path).trim();
    return password === '' ? undefined : password;
  } catch {
    return undefined;
  }
}

/**
 * The support mailer's settings from the environment. Fail closed: if any
 * variable is missing or invalid there are no settings, the portal still
 * starts and every /support path answers 404. The credential comes from a
 * file, never the environment. The mail server only accepts a sender equal to
 * the account that logged in, so a sender that differs from the SMTP user
 * disables support too.
 */
export function loadSupportSettings(
  env: Env,
  read: FileReader = readText,
  onFailure?: (code: SupportMailerErrorCode) => void
): SupportLoad {
  const names = SUPPORT_VARIABLES;
  const bad = new Set<string>();
  const host = present(env[names.host]) ? env[names.host]?.trim() : undefined;
  const port = portOf(env[names.port]);
  const security = securityOf(env[names.security]);
  const user = address(env[names.user]);
  const sender = address(env[names.sender]);
  const recipient = address(env[names.recipient]);
  const password = passwordFrom(env, read);

  if (host === undefined) bad.add(names.host);
  if (port === undefined) bad.add(names.port);
  if (security === undefined) bad.add(names.security);
  if (user === undefined) bad.add(names.user);
  if (password === undefined) bad.add(names.passwordFile);
  if (sender === undefined) bad.add(names.sender);
  if (recipient === undefined) bad.add(names.recipient);
  if (sender !== undefined && sender.toLowerCase() !== user?.toLowerCase()) {
    bad.add(names.sender);
    bad.add(names.user);
  }

  if (
    bad.size > 0 ||
    host === undefined ||
    port === undefined ||
    security === undefined ||
    user === undefined ||
    password === undefined ||
    sender === undefined ||
    recipient === undefined
  ) {
    return { support: undefined, disabledBecause: [...bad] };
  }
  return {
    support: {
      mailer: createSmtpSupportMailer({
        host,
        port,
        security,
        user,
        password,
        ...(onFailure === undefined ? {} : { onFailure }),
      }),
      recipient,
      sender,
    },
    disabledBecause: [],
  };
}

/** One stderr line saying support is off and which variables to look at. */
export function disabledLine(names: readonly string[]): string {
  return JSON.stringify({ event: 'support_disabled', variables: names });
}

/** One stderr line for a failed send: the short code and nothing the server or the tenant said. */
export function failureLine(code: SupportMailerErrorCode): string {
  return JSON.stringify({ event: 'support_send_failed', code });
}
