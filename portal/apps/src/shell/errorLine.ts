export type PortalErrorStep = 'bind' | 'landing' | 'action' | 'handler' | 'pool';

// A SQLSTATE: five characters, digits and capital letters (for example 25P03).
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The one line the portal writes when something fails: the step and the error's
 * name, never its message, because a message can carry connection details or a
 * subject. A pool event also carries the SQLSTATE `code` when the database
 * supplied one, so an operator can tell a statement timeout (57014) from an
 * idle-in-transaction kill (25P03) from a terminated backend (57P01).
 */
export function portalErrorLine(step: PortalErrorStep, error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = step === 'pool' ? sqlState(error) : undefined;
  return JSON.stringify({
    event: 'portal.error',
    step,
    error: name,
    ...(code === undefined ? {} : { code }),
  });
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined;
}
