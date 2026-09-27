---
'@zveltio/sdk': patch
---

`ctx.internals.createBetterAuthSession` takes `replaceExisting` and documents that the engine's
better-auth writes the session (database or Valkey), refusing a deactivated user with
`code: 'account_disabled'`.
