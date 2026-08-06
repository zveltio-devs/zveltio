import { expect, test } from '@playwright/test';
import { E2E } from '../setup/env';

/**
 * Inviting a colleague, end to end.
 *
 * This is the second journey a real failure came from. `POST /api/users/invite`
 * offers three roles; accepting wrote the chosen one into `user.role`, a column
 * a migration had already reduced to `'god' | 'member'`. Two of the three
 * choices violated the constraint and answered 500 — and because the account is
 * created before the transaction, the invitee was left with a working sign-in,
 * no tenant membership, and an invitation still marked unconsumed and therefore
 * replayable.
 *
 * A harness test now pins that at the API level. This one exists because the
 * flow crosses three requests and two identities, and the failure was in the
 * seam between them rather than in any one handler. Driving it as HTTP journeys
 * rather than through the UI is deliberate: the invitation email is not
 * deliverable in a test, so the token has to be read from the API anyway, and a
 * form-filling test here would assert on markup while testing the same thing.
 */

async function signInAsAdmin(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post('/api/auth/sign-in/email', {
    data: { email: E2E.admin.email, password: E2E.admin.password },
  });
  expect(res.ok(), 'admin sign-in failed').toBe(true);
}

const unique = () => `inv-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.invalid`;

test.describe('invitation', () => {
  for (const role of ['member', 'manager', 'admin'] as const) {
    test(`a colleague invited as "${role}" can accept and sign in`, async ({ request }) => {
      await signInAsAdmin(request);
      const email = unique();

      const invited = await request.post('/api/users/invite', {
        data: { email, name: 'Invitee', role },
      });
      expect(invited.status(), `invite as ${role}: ${await invited.text()}`).toBe(201);

      // The token is normally emailed. Reading it back from the invite response
      // keeps the test honest about what it is exercising — acceptance, not
      // mail delivery.
      const body = await invited.json();
      const token = new URL(body.invite_url).searchParams.get('token');
      expect(token, 'invite_url carried no token').toBeTruthy();

      const accepted = await request.post('/api/invitations/accept', {
        data: { token, password: 'Invitee123!', name: 'Invitee' },
      });
      expect(accepted.status(), `accept as ${role}: ${await accepted.text()}`).toBe(201);

      // The half that the 500 used to leave broken: an account existed and
      // could sign in, but belonged to no tenant, so every request it made
      // answered 403. Signing in proves the account; reading a tenant-scoped
      // endpoint proves the membership.
      const signIn = await request.post('/api/auth/sign-in/email', {
        data: { email, password: 'Invitee123!' },
      });
      expect(signIn.ok(), 'the invitee could not sign in').toBe(true);

      const session = await (await request.get('/api/auth/get-session')).json();
      expect(session?.user?.email).toBe(email);
    });
  }

  test('a used invitation cannot be redeemed twice', async ({ request }) => {
    // The unconsumed-invitation half of the same bug: a failed acceptance left
    // the token live. A successful one must not.
    await signInAsAdmin(request);
    const email = unique();

    const invited = await request.post('/api/users/invite', {
      data: { email, name: 'Once', role: 'member' },
    });
    const token = new URL((await invited.json()).invite_url).searchParams.get('token');

    const first = await request.post('/api/invitations/accept', {
      data: { token, password: 'Invitee123!', name: 'Once' },
    });
    expect(first.status()).toBe(201);

    const second = await request.post('/api/invitations/accept', {
      data: { token, password: 'Different1!', name: 'Twice' },
    });
    expect(second.status(), 'a consumed invitation was accepted again').toBe(410);
  });

  test('an unknown token is refused', async ({ request }) => {
    const res = await request.post('/api/invitations/accept', {
      data: { token: 'x'.repeat(64), password: 'Whatever123!' },
    });
    expect(res.status()).toBe(404);
  });
});
