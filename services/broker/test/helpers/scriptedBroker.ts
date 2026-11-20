import type {
  DemoBroker,
  ReconcileReply,
  ResetReply,
  SlotReading,
} from '../../src/controlPlaneDemoBroker.js';

/** A host that answers as scripted: each list is consumed in order, then its last entry repeats. */
export function scripted(
  replies: {
    reconcile?: ReconcileReply[];
    status?: (SlotReading | undefined)[];
    reset?: ResetReply[];
  } = {}
): DemoBroker & { sent: number; resets: number } {
  const reconcile = [...(replies.reconcile ?? [{ kind: 'running', colour: 'a' }])];
  const status = [...(replies.status ?? [{ phase: 'running', healthy: true }])];
  const reset = [...(replies.reset ?? ['free'])];
  const broker = {
    sent: 0,
    resets: 0,
    async reconcile() {
      broker.sent += 1;
      return reconcile.length > 1 ? reconcile.shift()! : reconcile[0]!;
    },
    async status() {
      return status.length > 1 ? status.shift() : status[0];
    },
    async reset() {
      broker.resets += 1;
      return reset.length > 1 ? reset.shift()! : reset[0]!;
    },
  };
  return broker;
}
