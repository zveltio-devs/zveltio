// Flows subsystem — workflow execution + scheduling. Public API; outside code
// imports from `lib/flows`, never the deep files (enforced by
// scripts/import-boundaries.ts). Grouped by H-08 from the flat lib/ root.
export {
  executeFlow,
  EXECUTABLE_STEP_TYPES,
  type ExecutableStepType,
  type FlowRunResult,
} from './flow-executor.js';
export { flowScheduler } from './flow-scheduler.js';
// Cron parsing lives here because flows needed it first, but it is not a flows
// concept — `lib/backup/scheduler.ts` computes a backup's next run with the same
// function. Exported through the barrel rather than reached into, which is what
// `scripts/import-boundaries.ts` asks for and the reason it caught this.
export { nextCronRun } from './cron.js';
export {
  validateStepConfig,
  type StepType,
  type StepValidationResult,
} from './flow-step-schemas.js';
// Cron parsing. Used by the flow scheduler and — since backup schedules are
// cron expressions too — by lib/backup/scheduler.ts, which must come through
// here rather than reaching into ./cron.js (scripts/import-boundaries.ts).
export { nextCronRun } from './cron.js';
