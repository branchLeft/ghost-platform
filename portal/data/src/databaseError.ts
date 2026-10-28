/** What a PostgreSQL error says about a refused statement. */
export interface DatabaseErrorInfo {
  code: string;
  constraint: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The SQLSTATE and constraint name of a driver error, looking through the
 * ORM's wrapper; undefined when the error is not the database's.
 */
export function readDatabaseError(error: unknown): DatabaseErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    const { code, constraint, cause } = current;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
    }
    current = cause;
  }
  return undefined;
}

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
