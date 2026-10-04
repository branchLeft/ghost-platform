import { randomBytes } from 'node:crypto';

export interface SessionRecord<S> {
  readonly subject: string;
  readonly orgId: string;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
  /** What the application bound at sign-in: the tenant scope for the portal. */
  readonly bound: S;
}

const MAX_ENTRIES = 10_000;

/** A bounded in-memory store of expiring entries under unguessable ids. */
export class ExpiringStore<V extends { readonly expiresAt: number }> {
  readonly #entries = new Map<string, V>();
  readonly #clock: () => number;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  /** Returns the new id, or null when the store is full of live entries. */
  put(value: V): string | null {
    if (this.#entries.size >= MAX_ENTRIES) this.#sweep();
    if (this.#entries.size >= MAX_ENTRIES) return null;
    const id = randomBytes(32).toString('base64url');
    this.#entries.set(id, value);
    return id;
  }

  get(id: string | undefined): V | null {
    if (id === undefined) return null;
    const value = this.#entries.get(id);
    if (!value) return null;
    if (value.expiresAt <= this.#clock()) {
      this.#entries.delete(id);
      return null;
    }
    return value;
  }

  /** Removes and returns the entry, so a one-time value cannot be used twice. */
  take(id: string | undefined): V | null {
    const value = this.get(id);
    if (value && id !== undefined) this.#entries.delete(id);
    return value;
  }

  delete(id: string | undefined): void {
    if (id !== undefined) this.#entries.delete(id);
  }

  #sweep(): void {
    const now = this.#clock();
    for (const [id, value] of this.#entries) {
      if (value.expiresAt <= now) this.#entries.delete(id);
    }
  }
}
