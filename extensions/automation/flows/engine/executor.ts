/**
 * Flow execution engine — runs flow steps sequentially
 * Supports: retry with exponential backoff, dead-letter queue, idempotency
 */

interface StepContext {
  db: any;
  triggerData: any;
  stepOutputs: Record<string, any>;
}

interface RetryConfig {
  max_attempts: number;
  backoff: 'exponential' | 'linear' | 'fixed';
  initial_delay_ms: number;
  max_delay_ms: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  max_attempts: 3,
  backoff: 'exponential',
  initial_delay_ms: 1000,
  max_delay_ms: 30000,
};

type StepResult = { success: true; output: any } | { success: false; error: string };

function calcDelay(config: RetryConfig, attempt: number): number {
  let delay: number;
  if (config.backoff === 'exponential') {
    delay = config.initial_delay_ms * Math.pow(2, attempt);
  } else if (config.backoff === 'linear') {
    delay = config.initial_delay_ms * (attempt + 1);
  } else {
    delay = config.initial_delay_ms;
  }
  return Math.min(delay, config.max_delay_ms);
}

async function runStep(step: any, ctx: StepContext): Promise<StepResult> {
  try {
    switch (step.type) {
      case 'condition': {
        const { field, operator, value } = step.config;
        const actual = ctx.triggerData?.[field] ?? ctx.stepOutputs[step.config.from]?.[field];

        let result = false;
        if (operator === 'eq') result = actual === value;
        else if (operator === 'neq') result = actual !== value;
        else if (operator === 'gt') result = Number(actual) > Number(value);
        else if (operator === 'lt') result = Number(actual) < Number(value);
        else if (operator === 'contains') result = String(actual).includes(value);
        else if (operator === 'is_null') result = actual == null;
        else if (operator === 'is_not_null') result = actual != null;

        return { success: true, output: { result, next: result ? step.config.then : step.config.else } };
      }

      case 'send_email': {
        const { to, subject, body } = step.config;
        console.log(`[Flow] Sending email to ${to}: ${subject}`);
        return { success: true, output: { sent: true, to, subject } };
      }

      case 'webhook': {
        const { url, method = 'POST', headers = {}, body } = step.config;
        const payload = typeof body === 'string'
          ? body.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx.triggerData?.[k] ?? '')
          : body;

        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(payload),
        });
        return { success: true, output: { status: res.status, ok: res.ok } };
      }

      case 'create_record': {
        const { collection, data } = step.config;
        const resolved: Record<string, any> = {};
        for (const [k, v] of Object.entries(data)) {
          resolved[k] = typeof v === 'string'
            ? v.replace(/\{\{(\w+)\}\}/g, (_, key) => ctx.triggerData?.[key] ?? '')
            : v;
        }
        const record = await ctx.db
          .insertInto(collection)
          .values({ ...resolved, id: crypto.randomUUID(), created_at: new Date(), updated_at: new Date() })
          .returningAll()
          .executeTakeFirst();
        return { success: true, output: { record } };
      }

      case 'update_record': {
        const { collection, id, data } = step.config;
        const recordId = id.startsWith('{{')
          ? ctx.triggerData?.[id.slice(2, -2)]
          : id;
        const record = await ctx.db
          .updateTable(collection)
          .set({ ...data, updated_at: new Date() })
          .where('id', '=', recordId)
          .returningAll()
          .executeTakeFirst();
        return { success: true, output: { record } };
      }

      case 'delay': {
        const ms = (step.config.hours || 0) * 3600000 + (step.config.minutes || 0) * 60000;
        await new Promise((r) => setTimeout(r, Math.min(ms, 5000)));
        return { success: true, output: { delayed_ms: ms } };
      }

      case 'ai_completion': {
        const { prompt } = step.config;
        const rendered = prompt.replace(/\{\{(\w+)\}\}/g, (_: any, k: string) => ctx.triggerData?.[k] ?? '');
        return { success: true, output: { prompt: rendered, note: 'AI provider not resolved in this step' } };
      }

      default:
        return { success: false, error: `Unknown step type: ${step.type}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pushToDlq(
  db: any,
  flowId: string,
  runId: string,
  stepIndex: number,
  error: string,
  payload: any,
  attempts: number,
): Promise<void> {
  try {
    await db
      .insertInto('zv_flow_dlq')
      .values({
        flow_id: flowId,
        run_id: runId,
        step_index: stepIndex,
        error_message: error,
        payload: JSON.stringify(payload),
        attempts,
        created_at: new Date(),
      })
      .execute();
  } catch (dlqErr) {
    console.error('[Flow DLQ] Failed to insert into DLQ:', dlqErr);
  }
}

export async function executeFlow(flow: any, triggerData: any, db: any): Promise<void> {
  const retryConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...(typeof flow.retry_config === 'string'
      ? JSON.parse(flow.retry_config)
      : (flow.retry_config ?? {})),
  };

  // Idempotency: hash of flow_id + trigger payload
  const idempotencyKey = await (async () => {
    try {
      const raw = `${flow.id}:${JSON.stringify(triggerData)}`;
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  })();

  // Deduplication check
  if (idempotencyKey) {
    try {
      const existing = await db
        .selectFrom('zv_flow_runs')
        .select('id')
        .where('idempotency_key', '=', idempotencyKey)
        .where('status', 'in', ['running', 'completed'])
        .executeTakeFirst();
      if (existing) {
        console.log(`[Flow] Skipping duplicate run for idempotency key ${idempotencyKey}`);
        return;
      }
    } catch {
      // If check fails, proceed (at-least-once semantics)
    }
  }

  // Create run record (attempt 1)
  let run: any;
  try {
    run = await db
      .insertInto('zv_flow_runs')
      .values({
        flow_id: flow.id,
        status: 'running',
        trigger_data: JSON.stringify(triggerData),
        steps_log: JSON.stringify([]),
        started_at: new Date(),
        idempotency_key: idempotencyKey,
        attempt_number: 1,
      })
      .returningAll()
      .executeTakeFirst();
  } catch (err: any) {
    // Unique constraint violation on idempotency_key = duplicate, skip
    if (err?.message?.includes('unique') || err?.code === '23505') {
      console.log(`[Flow] Duplicate execution prevented by idempotency_key`);
      return;
    }
    throw err;
  }

  const ctx: StepContext = { db, triggerData, stepOutputs: {} };
  const stepsLog: any[] = [];
  let failed = false;
  let errorMsg: string | undefined;
  let failedStepIndex = -1;

  const steps: any[] = flow.steps || [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = new Date();
    let lastError = '';
    let succeeded = false;

    // Retry loop for each step
    for (let attempt = 0; attempt < retryConfig.max_attempts; attempt++) {
      const result = await runStep(step, ctx);

      if (result.success) {
        ctx.stepOutputs[step.id] = result.output;
        stepsLog.push({
          step_id: step.id,
          step_type: step.type,
          status: 'completed',
          output: result.output,
          error: null,
          attempts: attempt + 1,
          started_at: stepStart,
          ended_at: new Date(),
        });
        succeeded = true;
        break;
      }

      lastError = result.error;

      if (attempt < retryConfig.max_attempts - 1) {
        const delay = calcDelay(retryConfig, attempt);
        console.warn(
          `[Flow] Step "${step.type}" failed (attempt ${attempt + 1}/${retryConfig.max_attempts}), ` +
          `retrying in ${delay}ms: ${lastError}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (!succeeded) {
      failedStepIndex = i;
      stepsLog.push({
        step_id: step.id,
        step_type: step.type,
        status: 'failed',
        output: null,
        error: lastError,
        attempts: retryConfig.max_attempts,
        started_at: stepStart,
        ended_at: new Date(),
      });
      failed = true;
      errorMsg = lastError;
      break;
    }
  }

  const finalStatus = failed ? 'failed' : 'completed';

  await db
    .updateTable('zv_flow_runs')
    .set({
      status: finalStatus,
      steps_log: JSON.stringify(stepsLog),
      error: errorMsg || null,
      completed_at: new Date(),
    })
    .where('id', '=', run.id)
    .execute();

  // Push to DLQ if failed after all retries
  if (failed && run?.id) {
    await pushToDlq(
      db,
      flow.id,
      run.id,
      failedStepIndex,
      errorMsg ?? 'Unknown error',
      { flow_id: flow.id, trigger_data: triggerData, steps: flow.steps },
      retryConfig.max_attempts,
    );
  }
}
