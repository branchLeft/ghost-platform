import { createHash } from 'node:crypto';

/**
 * The front door's logo check. A logo is untrusted media: it is hashed, the
 * hash is put to the safety service, and the demo request record is written
 * only when the service has recognised the hash and found no match. Anything
 * else refuses the request before a statement is spent, so a refused logo
 * leaves no row behind. The service is reached through an injected seam
 * (`getVerdict`, the shape of the scanning adapter's verdict client), so this
 * module owns no socket, address or credential.
 */

/** The seam: what the portal needs of the safety service's client. */
export interface LogoVerdictSource {
  getVerdict(hash: string): Promise<unknown>;
}

export interface LogoCheckOptions {
  readonly verdicts: LogoVerdictSource;
  /** A ceiling on the wait for an answer, in milliseconds; a hold is a refusal. */
  readonly timeoutMs?: number;
}

/** Why a logo was refused. None of them names what the service found. */
export type LogoRefusalReason = 'INVALID_LOGO' | 'TEST_LISTED' | 'BLOCKED' | 'UNAVAILABLE';

/** The request is refused: the logo is not usable, is on a list, or could not be checked. */
export class LogoRefusedError extends Error {
  constructor(readonly reason: LogoRefusalReason) {
    super(`front door: logo refused (${reason})`);
    this.name = 'LogoRefusedError';
  }
}

export const DEFAULT_TIMEOUT_MS = 5000;

const CLEAN = 'no-known-match';
const UNAVAILABLE = 'unavailable';

type Classification =
  typeof CLEAN | 'test' | 'csam' | 'harmful-abusive-material' | typeof UNAVAILABLE;

const REFUSED: Readonly<Record<string, LogoRefusalReason>> = {
  test: 'TEST_LISTED',
  csam: 'BLOCKED',
  'harmful-abusive-material': 'BLOCKED',
  [UNAVAILABLE]: 'UNAVAILABLE',
};

/** The 256-bit hash, lower-case hexadecimal, that the record holds and the service is asked about. */
export function hashLogo(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reads an answer to one hash. Only the exact, recognised classifications are
 * believed, and a clean answer must name the hash it answers. Everything else,
 * a malformed answer included, reads as unavailable: never clean.
 */
function readClassification(answer: unknown, hash: string): Classification {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return UNAVAILABLE;
  const { classification, evidence } = answer as { classification?: unknown; evidence?: unknown };
  if (typeof classification !== 'string') return UNAVAILABLE;
  if (classification === CLEAN) return evidence === hash ? CLEAN : UNAVAILABLE;
  // Own keys only: `toString` and its kin are not classifications.
  return Object.hasOwn(REFUSED, classification) ? (classification as Classification) : UNAVAILABLE;
}

/** Asks about one hash and never rejects: a throw, a rejection or a wait past the ceiling is unavailable. */
async function ask(
  verdicts: LogoVerdictSource,
  hash: string,
  timeoutMs: number
): Promise<Classification> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    const asking = Promise.resolve().then(() => verdicts.getVerdict(hash));
    // An answer that loses the race, or fails after it, must not surface as an unhandled rejection.
    asking.catch(() => undefined);
    return readClassification(await Promise.race([asking, deadline]), hash);
  } catch {
    return UNAVAILABLE;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hashes a submitted logo and puts the hash to the safety service. Returns the
 * hash when, and only when, the service answered no known match.
 *
 * @throws {LogoRefusedError} INVALID_LOGO, TEST_LISTED, BLOCKED or UNAVAILABLE.
 */
export async function checkLogo(bytes: Uint8Array, options: LogoCheckOptions): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new LogoRefusedError('INVALID_LOGO');
  }
  const hash = hashLogo(bytes);
  const verdict = await ask(options.verdicts, hash, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (verdict === CLEAN) return hash;
  throw new LogoRefusedError(REFUSED[verdict] ?? 'UNAVAILABLE');
}

/**
 * Runs a record write behind the logo check. With no logo the write runs with
 * no hash; with one, the write runs only after the check has passed and is
 * handed the hash it passed. A refusal rejects before `write` is called.
 *
 * @throws {LogoRefusedError} as `checkLogo`, in which case `write` was never called.
 */
export async function writeWithLogoCheck<T>(
  logo: Uint8Array | undefined,
  options: LogoCheckOptions,
  write: (logoHash: string | undefined) => Promise<T>
): Promise<T> {
  const logoHash = logo === undefined ? undefined : await checkLogo(logo, options);
  return write(logoHash);
}
