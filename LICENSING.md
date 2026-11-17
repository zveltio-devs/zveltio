# Licensing

Zveltio is open source. The server is licensed under the **GNU Affero General
Public License v3.0 only** (AGPL-3.0-only); the pieces you build your own
software with are licensed under **MIT**. Copyright © 2026 Liviu Marian
Iordache.

| Part | Where | Licence |
|---|---|---|
| Engine | `packages/engine` | AGPL-3.0-only ([LICENSE](LICENSE)) |
| Studio | `packages/studio` | AGPL-3.0-only |
| Client app | `packages/client` | AGPL-3.0-only |
| SDK, including the extension API (`@zveltio/sdk/extension`) | `packages/sdk` | MIT ([LICENSE](packages/sdk/LICENSE)) |
| React and Vue SDKs | `packages/sdk-react`, `packages/sdk-vue` | MIT |
| CLI and the projects it scaffolds | `packages/cli` | MIT |
| UI kit | `packages/ui` | MIT |

Releases up to and including `3.0.0-beta.124` were published under MIT and
stay under MIT. Every later release is licensed as above.

## What this means for you

**You build an application on Zveltio** (a web or mobile front end, a backend
that calls the HTTP API, a script using the SDK): your application is yours,
under any licence you choose. Talking to the engine over its API is not a
derivative work, and the SDK is MIT.

**You run Zveltio, unmodified, for yourself or your customers:** nothing to
do. The AGPL asks nothing of you beyond keeping the licence notices.

**You change the engine or Studio and let people use the changed version over
a network** (including selling it as a hosted service): the AGPL requires you to
offer those users the source of your changed version, under the AGPL. You may
still sell the service.

**You write an extension:** see the exception below. Your extension may be under
any licence, including a proprietary one.

**You cannot accept the AGPL** (company policy, an embedded or OEM product, a
hosted offering that keeps its changes private): a commercial licence is
available from the copyright holder, Liviu Marian Iordache — `licensing@zveltio.com`.

## Zveltio Extension Exception

Additional permission under section 7 of the GNU Affero General Public License,
version 3:

> As a special exception, the copyright holder of Zveltio gives you permission
> to combine, load and run Zveltio with an Extension, and to convey or offer
> over a network the resulting combination, without the Extension becoming
> subject to the terms of the GNU Affero General Public License. An
> "Extension" is a work that interacts with Zveltio only through the Zveltio
> extension interface: the extension manifest and what it declares
> (collections, fields, actions, jobs, routes, views), the `@zveltio/sdk`
> packages, and the engine's HTTP API. The Extension may be distributed under
> terms of your choice. This exception does not cover changes to Zveltio
> itself, which remain under the GNU Affero General Public License. If you
> modify Zveltio, you may extend this exception to your version, but you are
> not obliged to do so.

## The name

The licences cover the code, not the name. "Zveltio" and its logo may not be
used to name or promote a product or service that is not Zveltio itself — a
fork, a hosted offering — without written permission. Saying that your product
is "built on Zveltio" or "compatible with Zveltio" is fine.

## Contributing

Contributions are accepted under the [Contributor License Agreement](CLA.md),
which lets the copyright holder keep offering Zveltio under both the AGPL and
a commercial licence. You keep the copyright in your contribution.
