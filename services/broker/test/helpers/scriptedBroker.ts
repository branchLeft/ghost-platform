import type {
  DemoBroker,
  FreezeReply,
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
    freeze?: FreezeReply[];
  } = {}
): DemoBroker & { sent: number; resets: number; freezes: number; order: string[] } {
  const reconcile = [...(replies.reconcile ?? [{ kind: 'running', colour: 'a' }])];
  const status = [...(replies.status ?? [{ phase: 'running', healthy: true }])];
  const reset = [...(replies.reset ?? ['free'])];
  const freeze = [...(replies.freeze ?? ['detached'])];
  const broker = {
    sent: 0,
    resets: 0,
    freezes: 0,
    /** `freeze` and `reset` in the order they were sent. */
    order: [] as string[],
    async reconcile() {
      broker.sent += 1;
      return reconcile.length > 1 ? reconcile.shift()! : reconcile[0]!;
    },
    async status() {
      return status.length > 1 ? status.shift() : status[0];
    },
    async reset() {
      broker.resets += 1;
      broker.order.push('reset');
      return reset.length > 1 ? reset.shift()! : reset[0]!;
    },
    async freeze() {
      broker.freezes += 1;
      broker.order.push('freeze');
      return freeze.length > 1 ? freeze.shift()! : freeze[0]!;
    },
  };
  return broker;
}
