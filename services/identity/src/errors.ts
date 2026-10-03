/** Raised for any input the service refuses. Carries every problem found, so
 * an operator fixes a tenant list in one pass rather than one error per run. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid identity configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}
