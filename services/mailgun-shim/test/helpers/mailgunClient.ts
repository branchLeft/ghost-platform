import FormData from 'form-data';
import Mailgun from 'mailgun.js';
import type { Interfaces } from 'mailgun.js';

// mailgun.js's own .d.ts (`export default class Mailgun`) doesn't resolve
// a construct signature through this project's NodeNext moduleResolution
// (the package ships as CJS with no `type`/`exports` field) even though
// the runtime value is the constructor — verified directly: `new (await
// import('mailgun.js')).default(...)` returns a working client. This
// local type is the same shape mailgun-client.js relies on
// (mailgun-client.js:369-377), just spelled out so TS can check it.
type MailgunConstructor = new (formData: unknown) => {
  client(options: {
    username: string;
    key: string;
    url: string;
    timeout: number;
  }): Interfaces.IMailgunClient;
};

const MailgunCtor = Mailgun as unknown as MailgunConstructor;

/**
 * Builds a client exactly the way MailgunClient#getInstance does
 * (mailgun-client.js:369-377): Basic-auth username fixed to "api", `key`
 * as the password, `url` set to the base URL's origin only (doc 13 §1.3's
 * `baseUrl.origin` note).
 */
export function createMailgunClient(baseUrl: string, apiKey: string): Interfaces.IMailgunClient {
  const origin = new URL(baseUrl).origin;
  const mailgun = new MailgunCtor(FormData);
  return mailgun.client({ username: 'api', key: apiKey, url: origin, timeout: 10000 });
}
