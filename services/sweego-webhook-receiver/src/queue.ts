import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const QUEUE_MAX_BYTES = 5 * 1024 * 1024;

/** The whole stored record for a verified complaint. No recipient, no body. */
export interface QueueRecord {
  seq: number;
  outcomeId: string;
  class: string;
  at: number;
}

export class QueueFullError extends Error {
  constructor() {
    super('queue is at its hard cap');
  }
}

export interface Queue {
  /** Appends and fsyncs; throws QueueFullError rather than ever evicting. */
  append(record: Omit<QueueRecord, 'seq'>): number;
  /** Records with seq > after, oldest first. */
  read(after: number, limit: number): QueueRecord[];
  /** Removes records up to and including `through` once the collector holds them. */
  ack(through: number): number;
  stats(): { records: number; bytes: number; nextSeq: number; acked: number };
  close(): void;
}

function parseLines(text: string): QueueRecord[] {
  const out: QueueRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.length > 0) {
      out.push(JSON.parse(line) as QueueRecord);
    }
  }
  return out;
}

/**
 * Append-only newline-delimited JSON file with a byte cap. `acked` lives in a
 * second file so sequence numbers never repeat after the queue empties. Any
 * unreadable state throws at open: a receiver that cannot trust its queue does
 * not start, and a running one answers 503.
 */
export function openQueue(dir: string, maxBytes: number = QUEUE_MAX_BYTES): Queue {
  const queuePath = join(dir, 'queue.ndjson');
  const metaPath = join(dir, 'queue.meta');

  let acked = 0;
  if (existsSync(metaPath)) {
    acked = (JSON.parse(readFileSync(metaPath, 'utf8')) as { acked: number }).acked;
  }

  let text = existsSync(queuePath) ? readFileSync(queuePath, 'utf8') : '';
  // A crash mid-append leaves a final line with no newline: drop that stub.
  const lastNewline = text.lastIndexOf('\n');
  if (text.length > 0 && lastNewline !== text.length - 1) {
    text = text.slice(0, lastNewline + 1);
    truncateSync(queuePath, Buffer.byteLength(text, 'utf8'));
  }
  let records = parseLines(text);
  let bytes = Buffer.byteLength(text, 'utf8');
  let nextSeq = Math.max(acked, ...records.map((r) => r.seq)) + 1;
  let fd = openSync(queuePath, 'a');

  function reopenAfterRewrite(newText: string): void {
    const tmp = `${queuePath}.tmp`;
    writeFileSync(tmp, newText, { mode: 0o600 });
    const tmpFd = openSync(tmp, 'r');
    fsyncSync(tmpFd);
    closeSync(tmpFd);
    closeSync(fd);
    renameSync(tmp, queuePath);
    fd = openSync(queuePath, 'a');
  }

  return {
    append(record) {
      const full: QueueRecord = { seq: nextSeq, ...record };
      const line = JSON.stringify(full) + '\n';
      const size = Buffer.byteLength(line, 'utf8');
      if (bytes + size > maxBytes) {
        throw new QueueFullError();
      }
      writeSync(fd, line);
      fsyncSync(fd);
      records.push(full);
      bytes += size;
      nextSeq += 1;
      return full.seq;
    },
    read(after, limit) {
      return records.filter((r) => r.seq > after).slice(0, limit);
    },
    ack(through) {
      if (!Number.isInteger(through) || through < 0 || through >= nextSeq) {
        throw new RangeError('ack beyond the queue');
      }
      const keep = records.filter((r) => r.seq > through);
      const removed = records.length - keep.length;
      if (through > acked) {
        writeFileSync(metaPath, JSON.stringify({ acked: through }), { mode: 0o600 });
        acked = through;
      }
      if (removed > 0) {
        const newText = keep.map((r) => JSON.stringify(r) + '\n').join('');
        reopenAfterRewrite(newText);
        records = keep;
        bytes = Buffer.byteLength(newText, 'utf8');
      }
      return removed;
    },
    stats() {
      return { records: records.length, bytes, nextSeq, acked };
    },
    close() {
      closeSync(fd);
    },
  };
}
