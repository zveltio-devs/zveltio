---
'@zveltio/sdk': patch
---

Realtime clients stop when the engine revokes their credentials, and no client reconnects forever.

- `ZveltioRealtime` and `RealtimeClient` no longer reconnect when the engine closes the socket with `4001` (its session or API key was revoked); they call the new `onUnauthorized` callbacks instead. `ZveltioClient` forwards that to its `onUnauthorized` config callback. After a `4001`, `RealtimeClient.subscribe()` only records the subscription; the next explicit `connect()` sends it.
- `RealtimeClient` now gives up after 10 reconnect attempts, like `ZveltioRealtime`. A refused handshake (401) closes as `1002`/`1006` in every runtime, so it cannot be told apart from an outage.
- `RealtimeClient` accepts `{ headers }` like `ZveltioRealtime`, and `ZveltioClient` sends its `apiKey` as `X-API-Key` on the socket too.
- `watchSchema` sends its `apiKey` with the upgrade (it connected with no credentials, so the engine refused it every time), and stops and reports through `onError` on a `4001`.
