/**
 * Flow execution engine — runs flow steps sequentially
 */

interface StepContext {
  db: any;
  triggerData: any;
  stepOutputs: Record<string, any>;
}

type StepResult = { success: true; output: any } | { success: false; error: string };

async function runStep(step: any, ctx: StepContext): Promise<StepResult> {
  try {
    switch (step.type) {
      case 'condition': {
        // Simple JSONPath-like condition evaluation
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
        // In a full implementation, would use an email provider
        // Here we log the intent
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
        // In production, this would use a job queue with delayed execution
        const ms = (step.config.hours || 0) * 3600000 + (step.config.minutes || 0) * 60000;
        await new Promise((r) => setTimeout(r, Math.min(ms, 5000))); // cap at 5s in engine
        return { success: true, output: { delayed_ms: ms } };
      }

      case 'ai_completion': {
        // Uses core-ai if available
        const { prompt, system } = step.config;
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

export async function executeFlow(flow: any, triggerData: any, db: any): Promise<void> {
  const now = new Date();

  // Create run record
  const run = await db
    .insertInto('zv_flow_runs')
    .values({
      flow_id: flow.id,
      status: 'running',
      trigger_data: JSON.stringify(triggerData),
      steps_log: JSON.stringify([]),
      started_at: now,
    })
    .returningAll()
    .executeTakeFirst();

  const ctx: StepContext = { db, triggerData, stepOutputs: {} };
  const stepsLog: any[] = [];
  let failed = false;
  let errorMsg: string | undefined;

  const steps: any[] = flow.steps || [];

  for (const step of steps) {
    const stepStart = new Date();
    const result = await runStep(step, ctx);

    stepsLog.push({
      step_id: step.id,
      step_type: step.type,
      status: result.success ? 'completed' : 'failed',
      output: result.success ? result.output : null,
      error: result.success ? null : result.error,
      started_at: stepStart,
      ended_at: new Date(),
    });

    if (result.success) {
      ctx.stepOutputs[step.id] = result.output;
    } else {
      failed = true;
      errorMsg = result.error;
      break;
    }
  }

  await db
    .updateTable('zv_flow_runs')
    .set({
      status: failed ? 'failed' : 'completed',
      steps_log: JSON.stringify(stepsLog),
      error: errorMsg || null,
      completed_at: new Date(),
    })
    .where('id', '=', run.id)
    .execute();
}
