export { BumpStateMachine } from './bumpStateMachine.js';
export type {
  BumpState,
  BumpDependencies,
  BumpStateMachineOptions,
  StepResult,
  PersistSnapshot,
  RecoveredBumpState,
} from './bumpStateMachine.js';
export { createApplyLock } from './applyLock.js';
export type { ApplyLock } from './applyLock.js';
export { createFileTenantStateStore } from './tenantStateStore.js';
export type { PersistedTenantState, TenantStateStore } from './tenantStateStore.js';
export { acquireProcessLock, ProcessLockHeldError, DEFAULT_LOCK_PATH } from './processLock.js';
export type { ProcessLock, ProcessLockOptions } from './processLock.js';
export { recoverPersistedTenants } from './recovery.js';
export type { RecoveredTenant, RecoveryFailure, RecoverySweepResult } from './recovery.js';
