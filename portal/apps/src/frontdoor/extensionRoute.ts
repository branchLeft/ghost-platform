import { ExtensionRefusedError, type DemoEventView } from 'ghost-platform-portal-data/provisioner';
import {
  DemoExtensionExistsError,
  InvalidDemoExtensionError,
  NoDemoToExtendError,
  type DemoExtensionInput,
} from 'ghost-platform-portal-data/prospect';
import type { ProspectContact } from './provisionPage.js';
import {
  EXTENSION_CONSENT_WORDING,
  FIELDS,
  parseExtensionForm,
  renderExtensionAlreadyAsked,
  renderExtensionForm,
  renderExtensionGranted,
  renderExtensionNotGiven,
  renderNoDemo,
  type ExtensionChoices,
} from './extensionPage.js';

/**
 * The front door's extension route: `GET /extension` shows the form and
 * `POST /extension` records the request and, with consent recorded, asks for
 * the grant. The two ports are the data layer's: the front door's own role
 * records, the lifecycle worker's role grants, and this module holds neither
 * connection. The response is a status and a page; the entry point that
 * serves it is not in this module.
 *
 * Nothing moves without consent: a form without it is answered 422 before
 * either port is called. The wording stored is `EXTENSION_CONSENT_WORDING`,
 * the one the form showed, and never a field the browser sent.
 */
export interface ExtensionPorts {
  /** The front door's recording of a request for the address's own demo. */
  requestExtension(verifiedAddress: string, input: DemoExtensionInput): Promise<{ demoId: string }>;
  /** The lifecycle worker's grant: 14 days on the term, refused without consent on record. */
  grantExtension(demoId: string): Promise<DemoEventView>;
}

export interface ExtensionRequest {
  readonly method: string;
  /** The address the identity service verified; undefined when nobody is signed in. */
  readonly verifiedAddress: string | undefined;
  /** The posted form fields, for a POST. */
  readonly fields: Readonly<Record<string, string | undefined>>;
}

export interface ExtensionResponse {
  readonly status: number;
  /** Already-escaped markup. */
  readonly body: string;
}

export interface ExtensionDeps {
  readonly ports: ExtensionPorts;
  readonly contact: ProspectContact;
  readonly choices: ExtensionChoices;
}

const SIGN_IN_REQUIRED = '<h1>EXTENSION_SIGN_IN_HEADING</h1><p>EXTENSION_SIGN_IN_BODY</p>';

export async function handleExtension(
  request: ExtensionRequest,
  deps: ExtensionDeps
): Promise<ExtensionResponse> {
  const { contact, choices, ports } = deps;
  if (request.verifiedAddress === undefined) return { status: 401, body: SIGN_IN_REQUIRED };
  if (request.method === 'GET') {
    return { status: 200, body: renderExtensionForm(contact, choices) };
  }
  if (request.method !== 'POST') return { status: 405, body: '' };

  const parsed = parseExtensionForm(request.fields);
  if (!parsed.ok) {
    return { status: 422, body: renderExtensionForm(contact, choices, parsed.field) };
  }
  let demoId: string;
  try {
    ({ demoId } = await ports.requestExtension(request.verifiedAddress, {
      ...parsed.answers,
      consentWording: EXTENSION_CONSENT_WORDING,
    }));
  } catch (error) {
    if (error instanceof InvalidDemoExtensionError) {
      const field = Object.keys(FIELDS).includes(error.field)
        ? (error.field as keyof typeof FIELDS)
        : 'stillEvaluating';
      return { status: 422, body: renderExtensionForm(contact, choices, field) };
    }
    if (error instanceof NoDemoToExtendError) return { status: 404, body: renderNoDemo(contact) };
    if (error instanceof DemoExtensionExistsError) {
      return { status: 409, body: renderExtensionAlreadyAsked(contact) };
    }
    throw error;
  }
  try {
    await ports.grantExtension(demoId);
  } catch (error) {
    // The request is on record; the rules gave no extension. Say so, with the call to book.
    if (error instanceof ExtensionRefusedError) {
      return { status: 409, body: renderExtensionNotGiven(contact) };
    }
    throw error;
  }
  return { status: 200, body: renderExtensionGranted(contact) };
}
