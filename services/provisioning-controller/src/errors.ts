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
