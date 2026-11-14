import { escapeHtml } from '../shell/html.js';
import { MAX_CONTACT_LENGTH, MAX_MESSAGE_CHARACTERS } from './supportValidation.js';

/** Where each screen of the promotion journey is served and where it posts. */
export const ESSENTIALS_PATH = '/essentials';
export const ESSENTIALS_SEND_PATH = '/essentials/request';
export const ESSENTIALS_SENT_PATH = '/essentials/sent';
export const ESSENTIALS_OPEN_PATH = '/essentials/open-request';
export const ESSENTIALS_UNAVAILABLE_PATH = '/essentials/unavailable';

export const PROFESSIONAL_PATH = '/professional';
export const PROFESSIONAL_SEND_PATH = '/professional/send';
export const PROFESSIONAL_SENT_PATH = '/professional/sent';
export const PROFESSIONAL_LIMITED_PATH = '/professional/limited';

/**
 * The Essentials request: one button and no field. The tenant is the signed-in
 * session's and the tier is fixed by the route, so there is nothing to type.
 */
export function renderEssentialsForm(): string {
  return (
    '<h1>ESSENTIALS_TITLE</h1>' +
    `<form method="post" action="${escapeHtml(ESSENTIALS_SEND_PATH)}">` +
    '<p><button type="submit">REQUEST_ESSENTIALS</button></p></form>'
  );
}

/** Also the answer to asking again while the request is still waiting: nothing new is made. */
export function renderEssentialsSent(): string {
  return '<h1>ESSENTIALS_REQUEST_PENDING</h1>';
}

export function renderEssentialsOtherRequestOpen(): string {
  return '<h1>ANOTHER_REQUEST_ALREADY_OPEN</h1>';
}

export function renderEssentialsUnavailable(): string {
  return '<h1>ESSENTIALS_NOT_AVAILABLE_NOW</h1>';
}

/** The enquiry: the two things a tenant types and nothing else. */
export function renderProfessionalForm(): string {
  return (
    '<h1>PROFESSIONAL_ENQUIRY_TITLE</h1>' +
    `<form method="post" action="${escapeHtml(PROFESSIONAL_SEND_PATH)}">` +
    '<p><label>CONTACT_ADDRESS ' +
    `<input type="email" name="contact" required maxlength="${MAX_CONTACT_LENGTH}"></label></p>` +
    '<p><label>ENQUIRY_MESSAGE ' +
    `<textarea name="message" required maxlength="${MAX_MESSAGE_CHARACTERS}" rows="8"></textarea></label></p>` +
    '<p><button type="submit">SEND_ENQUIRY</button></p></form>'
  );
}

export function renderProfessionalSent(): string {
  return '<h1>ENQUIRY_SENT</h1>';
}

export function renderProfessionalLimited(): string {
  return '<h1>ENQUIRY_LIMIT_REACHED</h1>';
}

/** What a tenant that is not a demo sees where a form would be. */
export function renderNotForThisTenant(): string {
  return '<h1>NOT_FOR_THIS_TENANT</h1>';
}
