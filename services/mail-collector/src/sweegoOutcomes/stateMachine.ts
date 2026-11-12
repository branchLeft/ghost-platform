/**
 * The per-message state machine for outcomes polled from the Sweego
 * sending logs. Pure: no clock, no I/O. See ./README.md.
 */

export type MessageState =
  | 'submitted'
  | 'deferred'
  | 'delivered'
  | 'bounced-hard'
  | 'bounced-soft'
  | 'complained'
  | 'expired';

/** What one provider record, or the clock, says about one message. */
export type Observation =
  | { kind: 'queued'; deferred: boolean }
  | { kind: 'delivered' }
  | {
      kind: 'undelivered';
      bounce: 'hard' | 'soft' | null;
      code: number | null;
      message: string | null;
    }
  | { kind: 'complaint' }
  | { kind: 'timeout' };

export interface OutcomeDetail {
  code: number | null;
  message: string | null;
}

/** The outcome record handed to the spool: the existing delivered/failed shape, plus complained. */
export type SweegoReport =
  | { id: string; drainCount: number; outcome: 'delivered' }
  | {
      id: string;
      drainCount: number;
      outcome: 'failed';
      severity: 'permanent' | 'temporary';
      code?: number;
      message?: string;
    }
  | { id: string; drainCount: number; outcome: 'complained' };

export type ReportKind = 'delivered' | 'failed-permanent' | 'failed-temporary' | 'complained';

const NON_FINAL: readonly MessageState[] = ['submitted', 'deferred', 'bounced-soft', 'expired'];

/** True for a state a later observation may still change into a final word. */
export function isOpenState(state: MessageState): boolean {
  return NON_FINAL.includes(state);
}

/**
 * A bounce is permanent only when the provider says hard explicitly and any
 * SMTP code it carries is 5xx: a record that is vague, or contradicts itself,
 * can never suppress an address.
 */
export function isPermanentBounce(obs: {
  bounce: 'hard' | 'soft' | null;
  code: number | null;
}): boolean {
  if (obs.bounce !== 'hard') {
    return false;
  }
  return obs.code === null || (obs.code >= 500 && obs.code <= 599);
}

/**
 * The next state. Moves only forward: delivered never returns to
 * submitted, a hard bounce or a complaint is never overwritten, and a
 * timeout only closes messages that are still open. `expired` is not a
 * claim about the message: a late final word still replaces it.
 */
export function step(state: MessageState, obs: Observation): MessageState {
  switch (obs.kind) {
    case 'timeout':
      return state === 'submitted' || state === 'deferred' || state === 'bounced-soft'
        ? 'expired'
        : state;
    case 'queued':
      if (state === 'submitted' && obs.deferred) {
        return 'deferred';
      }
      return state;
    case 'delivered':
      return isOpenState(state) ? 'delivered' : state;
    case 'undelivered':
      if (isPermanentBounce(obs)) {
        // A bounce after "delivered" is a real asynchronous bounce.
        return state === 'bounced-hard' || state === 'complained' ? state : 'bounced-hard';
      }
      if (obs.bounce === null) {
        return state;
      }
      return state === 'submitted' || state === 'deferred' ? 'bounced-soft' : state;
    case 'complaint':
      return state === 'bounced-hard' ? state : 'complained';
  }
}

/** The report a state owes the spool, or null when it owes none (open states and `expired` report nothing). */
export function reportKindFor(state: MessageState): ReportKind | null {
  switch (state) {
    case 'delivered':
      return 'delivered';
    case 'bounced-hard':
      return 'failed-permanent';
    case 'bounced-soft':
      return 'failed-temporary';
    case 'complained':
      return 'complained';
    default:
      return null;
  }
}

export function toReport(
  key: { id: string; drainCount: number },
  state: MessageState,
  detail: OutcomeDetail
): SweegoReport | null {
  const base = { id: key.id, drainCount: key.drainCount };
  const extra = {
    ...(detail.code !== null ? { code: detail.code } : {}),
    ...(detail.message !== null ? { message: detail.message.slice(0, 500) } : {}),
  };
  switch (reportKindFor(state)) {
    case 'delivered':
      return { ...base, outcome: 'delivered' };
    case 'failed-permanent':
      return { ...base, outcome: 'failed', severity: 'permanent', ...extra };
    case 'failed-temporary':
      return { ...base, outcome: 'failed', severity: 'temporary', ...extra };
    case 'complained':
      return { ...base, outcome: 'complained' };
    default:
      return null;
  }
}
