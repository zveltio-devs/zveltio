#!/usr/bin/env bun
/**
 * Mint a VAPID keypair for Web Push.
 *
 * An operator has to get these two strings from somewhere, and the usual answer
 * — "install the `web-push` npm package and run its CLI" — asks them to add a
 * Node dependency to a Bun install in order to print two base64url values. The
 * engine already implements the same curve for APNS and for Web Push itself, so
 * this prints them from `lib/web-push.ts`, which means the keys are minted by
 * the code that will use them rather than by a second implementation that has
 * to agree with it.
 *
 *   bun run scripts/generate-vapid-keys.ts
 *
 * The private key is a secret: it is the half that proves deliveries come from
 * this install. Rotating it invalidates every existing subscription, because
 * the push service checks each request against the key the browser subscribed
 * with.
 */

import { generateVapidKeys } from '../packages/engine/src/lib/web-push.js';

const { publicKey, privateKey } = await generateVapidKeys();

console.log(`
Add these to your .env — all three are required, or Web Push stays off:

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
VAPID_SUBJECT=mailto:ops@example.com

  VAPID_SUBJECT must be a mailto: or https: URL that identifies you to the push
  service; some services refuse a JWT without one. Keep VAPID_PRIVATE_KEY
  secret, and note that changing it later unsubscribes every browser.
`);
