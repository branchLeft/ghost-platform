import { PlanOrderError } from './errors.js';
import type { PlannedStep } from './plan.js';

/**
 * The steps in an order that puts every step after all it depends on, keeping
 * the plan's own order wherever dependencies allow. A plan with a repeated or
 * unknown id, or a cycle, is refused rather than guessed at.
 */
export function orderSteps(steps: readonly PlannedStep[]): PlannedStep[] {
  const problems: string[] = [];
  const byId = new Map<string, PlannedStep>();
  for (const step of steps) {
    if (byId.has(step.id)) problems.push(`repeated step ${step.id}`);
    byId.set(step.id, step);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) problems.push(`${step.id} depends on unknown ${dep}`);
    }
  }
  if (problems.length > 0) throw new PlanOrderError(problems);

  const placed = new Set<string>();
  const ordered: PlannedStep[] = [];
  while (ordered.length < steps.length) {
    const next = steps.find((s) => !placed.has(s.id) && s.dependsOn.every((d) => placed.has(d)));
    if (next === undefined) {
      const stuck = steps.filter((s) => !placed.has(s.id)).map((s) => s.id);
      throw new PlanOrderError([`dependency cycle among ${stuck.join(', ')}`]);
    }
    placed.add(next.id);
    ordered.push(next);
  }
  return ordered;
}
