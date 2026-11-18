# Extension Archive Signatures — status & go-public transition

**Status (2026-07-30): ENFORCED by default.** A missing or invalid signature
fails the install. `REQUIRE_EXTENSION_SIGNATURES=false` remains as an escape
hatch for a private mirror that does not sign yet — to trust an *additional*
signer, add its key to `REGISTRY_PUBLIC_KEYS_JSON` rather than disabling
verification.

All four checklist steps below are done. Verified against the live registry on
2026-07-30: **57 of 57 official extensions serve a `.sig`** at the URL the engine
fetches, and a sample of six verify against the `registry-prod-2026` entry in
`BUILTIN_KEYS` using the engine's own `verifySignature` — which also confirms
gap 3, that the Worker's private key matches the compiled public half.

The history below is kept because it explains *why* the flip had to be last: for
most of the project's life the official sync path did not sign at all, so
enforcing signatures would have blocked every install rather than securing one.

---

## Your own extensions (level 3)

An extension your organisation writes for its own instance does not go through
the registry. You sign it with your own key, and the engine trusts that key
because you listed it (ADR 0056 d1):

```bash
zveltio keys generate --id my-org-2026
zveltio extension pack --dir ./acme-invoices          # isolation: "worker", bundled
zveltio extension sign --dir ./acme-invoices --key-id my-org-2026
zveltio install acme/invoices --path ./acme-invoices  # verifies, copies to EXTENSIONS_DIR
zveltio keys export my-org-2026                       # → OPERATOR_PUBLIC_KEYS_JSON on the engine
# restart the engine with that variable set, then, as the instance administrator:
zveltio extensions enable acme/invoices               # needs a second factor (step-up)
```

The marketplace lists every directory in `EXTENSIONS_DIR` whose manifest names
it, though no catalogue does. One whose `signature.json` holds against
`OPERATOR_PUBLIC_KEYS_JSON` shows that key (`operator_key_id`; `zveltio
extensions list` prints "yours, signed with key …") and is enabled like any
other extension: `zveltio extensions enable`, Studio's marketplace, or
`POST /api/marketplace/<name>/enable` with a step-up token; the load verifies
the signature again. One that is unsigned, or whose signature does not hold, is
listed with `operator_key_id: null` and the reason (`enable_refusal`), and
install and enable answer 422 with it. Enabling is what makes it act for the
tenants; a name listed only in `ZVELTIO_EXTENSIONS` is loaded but active for
none, and the list shows it installed, not enabled or running. Its actions and collections
then follow the engine's grants: by default `tenant_member` holds them, and a
new account has only `member` until it is given that role
(`POST /api/permissions/roles`) or another that holds the grants.

**Declared model only.** A level-3 extension has collections (declared in
`schema/collections/`), actions, jobs and declared routes (ADR 0039), and
nothing else (ADR 0056 d1):

- its `register()` is handed an app and a `ctx` that refuse every use: a
  `register()` that adds a route, reads `ctx.db` or touches any other `ctx`
  member fails the load, naming the member. Keep it `async register() {}`;
- the engine refuses, at the call, everything a `register()` ctx would send it
  (`ctx.db`, `ctx.services`, `ctx.events`, `checkPermission`, …), whatever the
  extension's process sends, and serves only its declared routes;
- `engine/migrations/*.sql` is refused at load: declare the collections;
- its jobs are default-exported from `engine/jobs.ts`, as every worker-isolated
  extension's ([authoring](authoring.md#actions-and-jobs--extension-api-v1)).

- **What is signed.** `signature.json` at the directory's root is the envelope
  above plus `"tier": "private"`. Its `bundleSha256` is the sha256 of a listing
  of the directory: a `zveltio-extension-dir/1` header, the name the engine
  loads it as, the tier, then `<sha256> <path>` for every regular file but
  `signature.json`, sorted. A symbolic link is refused.
- **Verified at every load**, not once at install, and again before every
  respawn of its process, against
  `OPERATOR_PUBLIC_KEYS_JSON` only. The process imports only the bundle bytes
  that hash to what the signature lists. A byte changed, a file added or removed, the
  directory renamed, or the tier rewritten after signing: the load is refused.
  A key the list does not name is refused too: a signed directory is never
  loaded as if it were unsigned.
- **Level 3, never more.** A signature claiming `first-party` or `certified`
  is refused: an operator key cannot confer level 0 or 1. The extension runs on
  the extension runner, as community code does (production refuses any other
  transport), never inline; a signed manifest that does not declare
  `engine.isolation: "worker"` with a bundle is refused, whatever the catalogue
  says of its name. Health (`/api/admin/extensions/health`) and every log line
  about it name the key: `[ext:acme/invoices key=my-org-2026]`.
- **Not a catalogue entry.** Listing your extension in a `catalog.json`
  override does not make it first-party: only the bundled catalogue and the
  registry name first-party extensions. Nor does it need one to be listed.
- **Not published.** `zveltio extension publish` leaves the root
  `signature.json` out of the archive: the registry signs what it serves.

The two key lists stay apart: a key in `REGISTRY_PUBLIC_KEYS_JSON` verifies
registry archives and is never consulted for a directory, and a key in
`OPERATOR_PUBLIC_KEYS_JSON` is never consulted for an archive.

## What runs inline (U3)

Only code the registry signed runs inside the engine process, and the engine
checks that at every load, not once at install (ADR 0056 amendment 4, ADR 0058):

- **The download keeps the signature with the files.** A verified archive is
  kept, with its `.sig`, in `.zveltio-registry/` inside the extension's
  directory.
- **Every load re-verifies it.** The signature against the registry keys
  (`BUILTIN_KEYS` and `REGISTRY_PUBLIC_KEYS_JSON`, never an operator key), then
  every file of the directory against the archive: a byte changed, a file added
  or removed since the download refuses the load. So does an archive whose
  manifest names another extension — a signed archive copied under a
  first-party name is not that extension. A kept signature that does not hold is
  refused; the directory is never loaded as if it were unsigned.
- **Unsigned is never inline in production,** whatever its name: a directory put
  there by hand, a source checkout, or an archive installed without a signature
  under `REQUIRE_EXTENSION_SIGNATURES=false`. It loads on the extension runner,
  as community code, when it is worker-isolated and bundled; otherwise it is
  refused, naming the reason.
- **Development and test** (`NODE_ENV=development` or `test`) keep the
  catalogue's word for an unsigned directory, so a source checkout of the
  first-party extensions runs as before.

Still from the catalogue: which tier a registry-signed extension has (bundled
catalogue or the registry's answer, by its name). The registry does not sign the
tier yet; until it does, the signature proves the files are what the registry
published under that name, and the name's publisher is the registry's to
enforce.

A production boot that loads extensions from disk without the registry (the
release smoke, the extensions' runtime probe) signs them as a download leaves
them, with a key made for that run and trusted through
`REGISTRY_PUBLIC_KEYS_JSON`: `bun scripts/sign-as-registry.ts <extensions-dir>`.

## Why signatures matter (threat model)

Extensions run **in-process as engine code** (unless `engine.isolation: "worker"`,
which only community/unverified publishers are forced into — see
`marketplace-policy.md`). So for a first-party / verified extension that runs
`inline`, tampered archive bytes = remote code execution in the engine.

TLS protects the archive *in transit* from `registry.zveltio.com`. The Ed25519
signature protects against **the registry itself serving tampered bytes** (a
compromised R2 bucket, a malicious mirror, a bad `REGISTRY_URL` override). It is
a defence-in-depth layer *below* the tier/isolation model, not a replacement for
it.

## What is already built

Engine side (`packages/engine/src/lib/security/`) — **complete**:

- `signature-verify.ts` — `parseSignature` + `verifySignature`. Verifies (a)
  `sha256(archive)` matches `bundleSha256`, (b) Ed25519 signature over the
  lowercase-hex sha256 string, (c) `keyId` resolves to a trusted key.
- `registry-keys.ts` — `BUILTIN_KEYS` **already contains** the production key
  `registry-prod-2026` (pubkey `7c9182ab…`). Operators can add keys via
  `REGISTRY_PUBLIC_KEYS_JSON` (private mirrors / rotation).
- `extension-download.ts` — fetches `<download_url>.sig`, gated by
  `REQUIRE_EXTENSION_SIGNATURES`. Missing → warn + proceed (default) or throw
  (when required). Invalid → **always** throw.

Registry side (`zveltio-devs/zveltio-registry`) — **partially wired**:

- `src/lib/registry-signer.ts` — `signArchive()` produces the exact
  `ExtensionSignature` shape the engine verifies. Private key in the
  `REGISTRY_SIGNING_PRIVATE_KEY_JWK` Worker secret.
- `src/routes/publish.ts` — the **CLI publish path** (`/api/v1/extensions/publish`)
  already signs and stores `<archiveKey>.sig`, and serves it at
  `/api/v1/extensions/:id/archive.sig`.

## The exact remaining gaps

> **All three gaps are CLOSED as of 2026-07-30.** Gaps 1 and 2 were fixed in the
> registry (`/upload-package` signs and stores `${key}.sig`;
> `serveExtensionPackage` serves it at `<download_url>.sig` for both lookup
> forms). The Worker was deployed and the official extensions re-synced, so the
> signatures now exist in R2. Gap 3 is confirmed by verification rather than
> inspection: live signatures validate against the compiled public key.
>
> The steps below are retained as the runbook for a key rotation or a second
> registry, where the same ordering applies.

There are **three**, and two live in the registry repo (a Cloudflare Worker), not
in `zveltio` or `zveltio-extensions`:

1. **The official-sync path does not sign.** The 54 first-party extensions are
   published via `POST /api/admin/upload-package/:name` (`src/routes/admin.ts`),
   driven by `zveltio-extensions/scripts/sync-to-registry.mjs`. That route does
   **not** call `signArchive`. → Add signing there, mirroring `publish.ts`.

2. **The `.sig` is not served at the URL the engine fetches.** The engine fetches
   `<download_url>.sig` where `download_url =
   /api/extensions/by-name/:name/download` (`src/routes/store.ts`). The signed
   publish path serves a *different* URL (`/api/v1/extensions/:id/archive.sig`).
   → `store.ts` must serve the stored `${storage_path}.sig` at
   `/api/extensions/by-name/:name/download.sig` **and** `/api/extensions/:id/download.sig`.

3. **Secrets + key parity.** Confirm `REGISTRY_SIGNING_PRIVATE_KEY_JWK` +
   `REGISTRY_SIGNING_KEY_ID` are set as Worker secrets, and that the public half
   equals `registry-prod-2026`'s `7c9182ab…` in `BUILTIN_KEYS`. If the private
   key for that pubkey does not exist, generate a fresh keypair
   (`zveltio keys generate --id registry-prod-<year>`), set the JWK secret, and
   replace the pubkey in `BUILTIN_KEYS` (ships in the next engine release).

## Go-public checklist (do in order — each step is verifiable)

1. **Registry: sign on the admin path.** Call `signArchive` in
   `admin.ts /upload-package`; store `${key}.sig` in R2. Serve it from `store.ts`
   at both download `.sig` URLs (gap #2).
2. **Re-sync all official extensions** so every archive gets a `.sig`.
3. **Verify against a clean install** with `REQUIRE_EXTENSION_SIGNATURES=true`:
   every official extension must install. This catches format mismatches before
   they affect anyone.
4. **Flip the default** to `true` in the engine (`extension-download.ts` /
   deployment env). Missing signature now blocks; invalid already did.

## Signing-scheme weaknesses (address BEFORE accepting third-party code)

The signature attests only to `sha256(archive)`. That is content-unique, but:

- **No identity/version binding.** The signed payload has no extension name or
  version. Fine for content integrity; if you revise the format (v2), sign
  `"zveltio-ext-v1:" + name + "@" + version + ":" + hex` for domain separation.
- **No expiry / revocation.** `signedAt` is informational, unverified. The only
  lever to distrust a key/version is an engine release that edits `BUILTIN_KEYS`.
  Third-party marketplace needs per-keyId (and ideally per-version) revocation.
- **No version-downgrade protection.** A validly-signed *old* (vulnerable)
  archive can be served. Sign + monotonically check the version if this matters.
- **Single compiled key = SPOF.** Stage a rotation/backup key via
  `REGISTRY_PUBLIC_KEYS_JSON` before you need it.

Official-only (all first-party, you control the pipeline) is fine to launch
without the four items above. **Identity-in-payload + revocation are mandatory
before the marketplace accepts third-party code.**

## Related

- `marketplace-policy.md` — three-tier publisher isolation (the primary trust
  boundary; signatures are defence-in-depth beneath it).
- `developer-guide.md` — the fail-closed `/ext/*` auth gate +
  `publicRoutes` manifest field.
