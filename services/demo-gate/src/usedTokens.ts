import { createHash } from 'node:crypto';
import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The record of used invitations: usedTokens.md. */
export interface InvitationLedger {
  /** Records `jti` as used. `true` only for the one caller that recorded it. */
  consume(jti: string, expiresAtSeconds: number, nowSeconds: number): Promise<boolean>;
  /** Whether `jti` is already recorded. A read: it never records. */
  isUsed(jti: string): Promise<boolean>;
}

/** Most records held at once. A full ledger refuses: evicting a record would re-open a replay. */
export const MAX_LEDGER_RECORDS = 10_000;

const SWEEP_EVERY_SECONDS = 30;
const RECORD_NAME = /^[0-9a-f]{64}$/;

function isCode(err: unknown, code: string): boolean {
  return (err as { code?: unknown } | undefined)?.code === code;
}

function recordName(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}

/**
 * `dir` is the gate's own, and must outlive the process: a record lost to a
 * restart would let a used link work again. One file per token, created
 * exclusively, so two requests carrying the same token cannot both succeed.
 */
export function createFileLedger(dir: string, maxRecords = MAX_LEDGER_RECORDS): InvitationLedger {
  let lastSweep = Number.NEGATIVE_INFINITY;

  // A record is dropped only after its own expiry, when the token would be
  // refused as expired anyway. An unreadable record is kept until it is older
  // than any token could be.
  async function sweep(nowSeconds: number): Promise<number> {
    lastSweep = nowSeconds;
    let kept = 0;
    for (const name of await readdir(dir)) {
      if (!RECORD_NAME.test(name)) continue;
      const path = join(dir, name);
      let expires = Number.NaN;
      try {
        expires = Number.parseInt(await readFile(path, 'utf8'), 10);
        if (!Number.isFinite(expires)) {
          expires = Math.floor((await stat(path)).mtimeMs / 1000) + 2 * 900;
        }
      } catch {
        kept += 1;
        continue;
      }
      if (expires <= nowSeconds) await rm(path, { force: true });
      else kept += 1;
    }
    return kept;
  }

  return {
    async consume(jti, expiresAtSeconds, nowSeconds) {
      let kept: number | undefined;
      if (nowSeconds - lastSweep >= SWEEP_EVERY_SECONDS) kept = await sweep(nowSeconds);
      kept ??= (await readdir(dir)).filter((name) => RECORD_NAME.test(name)).length;
      if (kept >= maxRecords) return false;
      try {
        const handle = await open(join(dir, recordName(jti)), 'wx', 0o600);
        try {
          await handle.writeFile(String(expiresAtSeconds), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return true;
      } catch (err) {
        if (isCode(err, 'EEXIST')) return false;
        throw err;
      }
    },
    async isUsed(jti) {
      try {
        await stat(join(dir, recordName(jti)));
        return true;
      } catch (err) {
        if (isCode(err, 'ENOENT')) return false;
        throw err;
      }
    },
  };
}
