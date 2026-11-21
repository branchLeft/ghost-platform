/** Thrown at start-up when a demo ceiling variable is set to something that is not a positive whole number. */
export class InvalidDemoCeilingError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} must be a positive integer`);
    this.name = 'InvalidDemoCeilingError';
  }
}
