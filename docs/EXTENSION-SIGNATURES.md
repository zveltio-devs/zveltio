# Extension Archive Signatures — status & go-public transition

**Status (2026-07-24): built but intentionally NOT enforced by default.**
Missing signatures are accepted (warn-only); *invalid* signatures are always
rejected. This is the correct posture **today** because the registry does not
yet emit `.sig` files for the official-extension sync path. Flipping enforcement
on now would break every official-extension install.

This document is the checklist to flip it when the third-party marketplace opens.
Do **not** enable `REQUIRE_EXTENSION_SIGNATURES=true` before completing it.

---

## Why signatures matter (threat model)

Extensions run **in-process as engine code** (unless `engine.isolation: "worker"`,
which only community/unverified publishers are forced into — see
`MARKETPLACE-POLICY.md`). So for a first-party / verified extension that runs
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

- `MARKETPLACE-POLICY.md` — three-tier publisher isolation (the primary trust
  boundary; signatures are defence-in-depth beneath it).
- `EXTENSION-DEVELOPER-GUIDE.md` — the fail-closed `/ext/*` auth gate +
  `publicRoutes` manifest field.
