export { BumpStateMachine } from './bumpStateMachine.js';
export type {
  BumpState,
  BumpDependencies,
  StepResult,
  RecoveredBumpState,
} from './bumpStateMachine.js';
export { createApplyLock } from './applyLock.js';
export type { ApplyLock } from './applyLock.js';
export { createFileTenantStateStore } from './tenantStateStore.js';
export type { PersistedTenantState, TenantStateStore } from './tenantStateStore.js';
export { acquireProcessLock, ProcessLockHeldError } from './processLock.js';
export type { ProcessLock } from './processLock.js';
export { recoverPersistedTenants } from './recovery.js';
export type { RecoveredTenant } from './recovery.js';
