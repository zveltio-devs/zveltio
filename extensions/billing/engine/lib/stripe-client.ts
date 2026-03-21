import type { Database } from '../../../../packages/engine/src/db/index.js';

let _db: Database | null = null;

export function initStripeClient(db: Database): void {
  _db = db;
}

async function verifyStripeSignature(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  // Parse signature header: t=timestamp,v1=sig1,v1=sig2...
  const parts: Record<string, string[]> = {};
  for (const part of signature.split(',')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx);
    const v = part.slice(eqIdx + 1);
    if (!parts[k]) parts[k] = [];
    parts[k].push(v);
  }

  const timestamp = parts['t']?.[0];
  const v1Sigs = parts['v1'] ?? [];
  if (!timestamp || v1Sigs.length === 0) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(signedPayload));
  const computed = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return v1Sigs.some((sig) => sig === computed);
}

export interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

export async function handleWebhook(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<{ handled: boolean; event?: StripeEvent; error?: string }> {
  const valid = await verifyStripeSignature(rawBody, signature, secret);
  if (!valid) {
    return { handled: false, error: 'Invalid signature' };
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { handled: false, error: 'Invalid JSON body' };
  }

  if (!_db) return { handled: true, event };

  const obj = event.data.object as any;

  switch (event.type) {
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const stripeSubId = obj.id as string;
      const newStatus = event.type === 'customer.subscription.deleted' ? 'canceled' : (obj.status as string);
      const periodStart = obj.current_period_start
        ? new Date((obj.current_period_start as number) * 1000)
        : null;
      const periodEnd = obj.current_period_end
        ? new Date((obj.current_period_end as number) * 1000)
        : null;

      await (_db as any)
        .updateTable('zv_billing_subscriptions')
        .set({
          status: newStatus,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          updated_at: new Date(),
        })
        .where('stripe_subscription_id', '=', stripeSubId)
        .execute();
      break;
    }

    case 'invoice.payment_succeeded': {
      const stripeSubId = obj.subscription as string;
      if (stripeSubId) {
        await (_db as any)
          .updateTable('zv_billing_subscriptions')
          .set({ status: 'active', updated_at: new Date() })
          .where('stripe_subscription_id', '=', stripeSubId)
          .execute();
      }
      break;
    }

    case 'invoice.payment_failed': {
      const stripeSubId = obj.subscription as string;
      if (stripeSubId) {
        await (_db as any)
          .updateTable('zv_billing_subscriptions')
          .set({ status: 'past_due', updated_at: new Date() })
          .where('stripe_subscription_id', '=', stripeSubId)
          .execute();
      }
      break;
    }
  }

  return { handled: true, event };
}
