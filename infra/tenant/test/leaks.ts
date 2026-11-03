import * as pulumi from '@pulumi/pulumi';
import { vi } from 'vitest';
import { created, settle, unwrap } from './harness';

/** One value a component hands to Pulumi, and whether Pulumi would store it as a secret. */
export interface Exposure {
  where: string;
  secret: boolean;
  value: unknown;
}

/**
 * Every way a component hands a value to the stack: each public field, each
 * input it registered, and each entry it passed to `registerOutputs()`. The
 * last is what the stack state stores, and Pulumi's mocks never show it, so
 * it is captured at the call.
 */
export async function gatherExposures(
  name: string,
  make: () => pulumi.ComponentResource
): Promise<{ exposures: Exposure[]; recordedKeys: string[] }> {
  const calls: Record<string, unknown>[] = [];
  // `registerOutputs` is protected, so it is reached through a structural view.
  const prototype = pulumi.ComponentResource.prototype as unknown as {
    registerOutputs(outputs?: unknown): void;
  };
  const spy = vi.spyOn(prototype, 'registerOutputs').mockImplementation((outputs?: unknown) => {
    calls.push(outputs as Record<string, unknown>);
  });
  let component: pulumi.ComponentResource;
  try {
    component = make();
  } finally {
    spy.mockRestore();
  }
  if (calls.length !== 1) {
    throw new Error(`expected one registerOutputs() call, saw ${calls.length}`);
  }

  const exposures: Exposure[] = [];
  for (const [field, value] of Object.entries(component)) {
    if (field.startsWith('__')) {
      continue;
    }
    if (pulumi.Output.isInstance(value)) {
      exposures.push({
        where: `field ${field}`,
        secret: await pulumi.isSecret(value),
        value: await unwrap(value),
      });
    } else {
      exposures.push({ where: `field ${field}`, secret: false, value });
    }
  }
  for (const [key, raw] of Object.entries(calls[0])) {
    const output = pulumi.output(raw as pulumi.Input<unknown>);
    exposures.push({
      where: `registered output ${key}`,
      secret: await pulumi.isSecret(output),
      value: await unwrap(output),
    });
  }
  await settle();
  const registered = created.filter((resource) => resource.name === name);
  if (registered.length !== 1) {
    throw new Error(`expected one resource named ${name}, saw ${registered.length}`);
  }
  exposures.push({ where: 'registered inputs', secret: false, value: registered[0].inputs });
  return { exposures, recordedKeys: Object.keys(calls[0]) };
}

/**
 * What is wrong with what a component exposed: any value that is a Pulumi
 * secret, any value carrying a sentinel, and any output key off the
 * allowlist. An empty list is the all-clear, and only means something where
 * a leaking stand-in has been shown to make this list non-empty.
 */
export function findLeaks(
  exposed: { exposures: Exposure[]; recordedKeys: string[] },
  sentinels: readonly string[],
  allowedOutputKeys: readonly string[]
): string[] {
  const problems: string[] = [];
  for (const { where, secret, value } of exposed.exposures) {
    if (secret) {
      problems.push(`${where} is a Pulumi secret`);
    }
    const text = (typeof value === 'string' ? value : JSON.stringify(value)) ?? '';
    for (const sentinel of sentinels) {
      if (text.toLowerCase().includes(sentinel.toLowerCase())) {
        problems.push(`${where} carries a sentinel value`);
        break;
      }
    }
  }
  const allowed = new Set(allowedOutputKeys);
  for (const key of exposed.recordedKeys) {
    if (!allowed.has(key)) {
      problems.push(`registered output ${key} is not on the allowlist`);
    }
  }
  for (const key of allowedOutputKeys) {
    if (!exposed.recordedKeys.includes(key)) {
      problems.push(`allowlisted output ${key} was not registered`);
    }
  }
  return problems;
}
