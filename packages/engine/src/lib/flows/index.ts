// Flows subsystem — workflow execution + scheduling. Public API; outside code
// imports from `lib/flows`, never the deep files (enforced by
// scripts/import-boundaries.ts). Grouped by H-08 from the flat lib/ root.
export { executeFlow, type FlowRunResult } from './flow-executor.js';
export { flowScheduler } from './flow-scheduler.js';
export {
  validateStepConfig,
  type StepType,
  type StepValidationResult,
} from './flow-step-schemas.js';
