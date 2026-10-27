import { escapeHtml } from '../shell/html.js';
import { MAX_CONTACT_LENGTH, MAX_MESSAGE_CHARACTERS } from './supportValidation.js';

/**
 * The support form: the two things a tenant types and nothing else. The
 * tenant, the version, the health and the screen are never form fields.
 */
export function renderSupportForm(sendPath: string): string {
  return (
    '<h1>SUPPORT_TITLE</h1>' +
    `<form method="post" action="${escapeHtml(sendPath)}">` +
    '<p><label>CONTACT_ADDRESS ' +
    `<input type="email" name="contact" required maxlength="${MAX_CONTACT_LENGTH}"></label></p>` +
    '<p><label>SUPPORT_MESSAGE ' +
    `<textarea name="message" required maxlength="${MAX_MESSAGE_CHARACTERS}" rows="8"></textarea></label></p>` +
    '<p><button type="submit">SEND_TICKET</button></p></form>'
  );
}

export function renderTicketSent(): string {
  return '<h1>TICKET_SENT</h1>';
}

export function renderTicketLimited(): string {
  return '<h1>TICKET_LIMIT_REACHED</h1>';
}

/** The small link each screen carries to the support form for that screen. */
export function renderSupportLink(pagePath: string): string {
  return `<p><a href="${escapeHtml(pagePath)}">SUPPORT_LINK</a></p>`;
}
