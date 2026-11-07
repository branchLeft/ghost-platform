import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** A name ending in one of these is a credential for some service that could be a model. Matched ignoring case. */
export const MODEL_ENV_SUFFIXES: readonly string[] = Object.freeze(['_API_KEY']);

/** A name starting with one of these belongs to a model vendor's tooling. Matched ignoring case. */
export const MODEL_ENV_PREFIXES: readonly string[] = Object.freeze([
  'ANTHROPIC_',
  'OPENAI_',
  'CLAUDE_CODE_',
]);

/** An agent binary that must not be resolvable on `PATH`. */
export const AGENT_BINARIES: readonly string[] = Object.freeze(['claude']);

export type ModelFreeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Names the variable or the binary, never a value: this error reaches logs
 * and the hold sink, and a credential must not travel with it.
 */
export class ModelKeyPresentError extends Error {
  constructor(
    readonly source: 'environment' | 'path',
    readonly name: string
  ) {
    super(
      source === 'environment'
        ? `refusing to run: environment variable ${name} is set; the ring controller runs with no model in its path`
        : `refusing to run: agent binary ${name} is resolvable on PATH; the ring controller runs with no model in its path`
    );
    this.name = 'ModelKeyPresentError';
  }
}

function isModelVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    MODEL_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix)) ||
    MODEL_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first agent binary resolvable through the given `PATH`, or undefined. An empty entry means the current directory, as in a shell. */
function findAgentBinary(pathVariable: string | undefined): string | undefined {
  if (pathVariable === undefined) {
    return undefined;
  }
  for (const directory of pathVariable.split(delimiter)) {
    for (const binary of AGENT_BINARIES) {
      if (isExecutableFile(join(directory === '' ? '.' : directory, binary))) {
        return binary;
      }
    }
  }
  return undefined;
}

/**
 * Pure of process state: reads only the `env` it is given (D37, no model in
 * the path). Throws when the environment holds a model credential or a
 * model tooling variable, or when an agent binary can be found on its
 * `PATH`. The first finding wins; its message names it without any value.
 */
export function assertModelFreeEnvironment(env: ModelFreeEnvironment): void {
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isModelVariable(name)) {
      throw new ModelKeyPresentError('environment', name);
    }
  }
  const agent = findAgentBinary(env['PATH']);
  if (agent !== undefined) {
    throw new ModelKeyPresentError('path', agent);
  }
}
