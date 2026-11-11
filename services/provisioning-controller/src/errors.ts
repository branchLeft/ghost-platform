export class ApprovalRequiredError extends Error {
  constructor(readonly approvalId: string) {
    super(`No recorded approval for ${approvalId}; nothing is planned without one.`);
    this.name = 'ApprovalRequiredError';
  }
}

export class ApprovalScopeError extends Error {
  constructor(
    readonly approvalId: string,
    readonly missing: readonly string[]
  ) {
    super(`Approval ${approvalId} does not cover: ${missing.join(', ')}.`);
    this.name = 'ApprovalScopeError';
  }
}

export class RegisterEntryMissingError extends Error {
  constructor(readonly tenantId: string) {
    super(`The tenant register has no entry for ${tenantId}.`);
    this.name = 'RegisterEntryMissingError';
  }
}

export class RegisterEntryInvalidError extends Error {
  constructor(
    readonly tenantId: string,
    readonly fields: readonly string[]
  ) {
    super(`Register entry for ${tenantId} is unusable: ${fields.join(', ')}.`);
    this.name = 'RegisterEntryInvalidError';
  }
}

/** A host entry point throws this when retrying cannot help; the step fails at once. */
export class PermanentStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentStepError';
  }
}

export class StateStoreUnreadableError extends Error {
  constructor(cause: unknown) {
    super('The state store could not be read; nothing was run.', { cause });
    this.name = 'StateStoreUnreadableError';
  }
}

export class StateStoreWriteError extends Error {
  constructor(cause: unknown) {
    super('The state store did not accept a record; the run stopped before acting on it.', {
      cause,
    });
    this.name = 'StateStoreWriteError';
  }
}

export class StateCorruptError extends Error {
  constructor(
    readonly line: number,
    detail: string
  ) {
    super(`State file line ${line} is unusable: ${detail}.`);
    this.name = 'StateCorruptError';
  }
}

export class PlanOrderError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The plan cannot be ordered: ${problems.join('; ')}.`);
    this.name = 'PlanOrderError';
  }
}

export class InvalidRunOptionsError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Unusable retry policy: ${fields.join(', ')}.`);
    this.name = 'InvalidRunOptionsError';
  }
}
