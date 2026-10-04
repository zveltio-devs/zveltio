# RFC: third-party extensions run out of process

Status: **proposed**. Owner decision required before implementation.

## Problem

Community-tier (third-party) extensions run in a worker
(`lib/worker-extension-host.ts`), and the worker is a thread inside the engine
process.
- What it gives: it keeps the extension out of the engine's JavaScript objects.
  The SQL bridge narrows what the extension may touch, and the `env` option keeps
  the engine's variables out of the JavaScript environment APIs.
- What it cannot give: the thread can still read what the process can read. So
  it is not a boundary for code the operator does not trust.

[#906](https://github.com/zveltio-devs/zveltio/pull/906) makes production refuse
worker extensions unless the operator opts in. That is a stopgap; this RFC is the
fix.

Every in-process layer tried so far has been worked around in turn: a `process`
stub, the Worker `env` option, an SSRF filter inside the runtime. The common cause
is the shape, not any one bug.

> **Principle.** The boundary around untrusted extension code is the operating
> system (or a WebAssembly instance), never the JavaScript runtime it shares with
> the engine.

## Goals

1. An extension that is fully hostile inside its sandbox learns nothing worth
   having:
   - no engine secrets;
   - no database credentials;
   - no engine files;
   - no other extension's data;
   - no network the operator did not allow.
2. Extension authors keep the current model: TypeScript, `ZveltioExtension`,
   manifest v2, the same `ctx` surface. The SDK extension surface is API-stable in
   beta.
3. Per-extension resource limits that the kernel enforces: memory, CPU, process
   count. A crash or OOM is confined to one extension.
4. One design across the deployment targets the engine ships for: Docker/compose,
   Helm, and the bare-metal single binary.

## Non-goals

- First-party extensions keep running inline. They are signed and maintained in
  `zveltio-extensions`, and they use engine-side hooks (field types, cron,
  cleanup) that out-of-process code cannot provide.
- A WebAssembly runtime for JavaScript extensions. See "Alternatives".

## Design

### The runner

A **runner** is a process with nothing worth stealing:
- an empty environment, except what it needs to start;
- no database connection;
- no read access to the engine's files;
- no route to anything the operator did not allow.

Each worker-isolated extension runs in its own runner process.

The runner hosts the code that `worker-extension-runtime.ts` runs today. Only the
transport changes: `postMessage` becomes a byte stream.

### Transport and protocol

`lib/worker-extension-protocol.ts` already has the right shape. Every interaction
is a serialisable message:
- `init`;
- `route:invoke`;
- `db:query`;
- `service:call`, `service:register`, `service:invoke`;
- `log`;
- `ping` / `pong`;
- `shutdown`.

The proposal:
- **Framing:** length-prefixed JSON over a socketpair or stdio pipe created at
  spawn. No listening port, and no filesystem socket the extension could share.
- **Protocol version** in `init`, alongside the existing `WASM_HOST_ABI_VERSION`
  practice. A mismatch refuses to start.
- **Authentication:** the channel is created by the engine and inherited only by
  that child, so the channel itself is the identity. Every message the engine
  receives is attributed to the extension the runner was spawned for, never to a
  name inside the message.
- **Request bodies and responses** are streamed in frames with a size cap. Today's
  worker copies whole bodies.

### Database access

Unchanged in principle: `db:query` crosses to the engine. The engine executes it:
- with the extension's own database role (#885);
- under the statement policy (`worker-sql-policy.ts`);
- with a statement timeout;
- in the caller's tenant, which is not RLS-scoped today; tenant scoping becomes
  part of this change.

The runner never holds a connection string.

### Isolation per deployment target

| Target | Runner placement | Isolation provided by |
|---|---|---|
| Docker / compose | A separate `zveltio-ext-runner` service. The engine spawns extension processes in it over a control channel. | Separate container: no engine volumes or env, own network with egress policy, cgroup limits per container (or per process via a cgroup v2 subtree). |
| Kubernetes / Helm | A sidecar container in the engine pod, or a separate Deployment. | As above, plus `NetworkPolicy` for egress, `securityContext` (non-root, read-only rootfs, no privilege escalation, seccomp `RuntimeDefault`). |
| Bare metal (single binary) | A child process per extension, under a dedicated system user that the installer creates (`zveltio-ext`). | A different uid (so the engine's files, environment and process state are out of reach), `systemd-run --scope` limits where available (the edge-function runner already probes for them), and landlock where the kernel supports it. |
| Development | The current in-thread worker. | Nothing. The engine logs a warning, and the production gate from #906 keeps it out of production. |

A child under the **same** uid with an empty environment is *not* enough. Processes
of one user can inspect each other, and they share file permissions. The table
above never relies on that.

### Network

The in-runtime SSRF filter (`installFetchGuard`) becomes defence in depth. The
boundary is the container network policy or, on bare metal, a per-uid firewall rule
the installer adds. Operators declare allowed egress per extension in the extension
config. The manifest can request it, and the operator grants it.

### Lifecycle and failure

- **Spawn:** on enable. **Respawn:** on crash, with the current exponential
  backoff.
- **Heartbeat:** `ping`/`pong` as today.
- **Hard limits:**
  - memory and CPU from the kernel;
  - wall-clock per `route:invoke` from the engine;
  - an extension past its limit is killed, and the request answers 503 with a
    trace id.
- **Disable:** terminates the runner, drops the role grants (as #885 does today) and
  unmounts the proxy routes.
- **Hot reload:** restarts the runner. It never reloads in place.

### Edge functions

`lib/edge-functions/subprocess-runner.ts` already spawns a process per invocation
with a minimal environment and a memory ceiling, but under the engine's uid. It
moves onto the same runner placement, which closes the same-uid gap for edge
functions too.

## Migration plan

0. **Done in #906:** the production opt-in for worker extensions, and corrected
   documentation.
1. **This RFC accepted.** Settle the open questions below.
2. **Transport:**
   - put a byte-stream transport behind the existing protocol, with the in-thread
     worker kept as the development transport;
   - a contract test runs the same extension over both transports and expects
     identical results.
3. **Bare-metal runner:**
   - dedicated uid, process-per-extension and kernel limits;
   - an isolation test that must fail on today's worker and pass on the runner. It
     asserts that the extension cannot read engine files, engine process state or
     a non-allowed network address.
4. **Container runner:** compose and Helm, with the same isolation test run in CI
   against the compose stack.
5. **Edge functions** move to the runner.
6. **Default flip:** production uses the runner, and the in-thread worker is
   development only. The #906 opt-in variable then guards the dev transport
   instead.

## Alternatives considered

**WebAssembly for every third-party extension** (`lib/wasm-extension-host.ts`).
This gives the strongest in-process isolation, but today:
- the host cannot bind HTTP routes; there is no routing ABI;
- `fetch` is a stub;
- there is no SDK or toolchain.

JavaScript extensions would have to run through an embedded JS engine compiled to
WASM, which means slower execution and a large part of npm unavailable. WASM stays
the right target for compute-only extensions and possibly for a large anonymous
marketplace later. It is not the path for the existing TypeScript extension model.

**Bun-level permissions.** Bun has no permission model comparable to Deno's
`--allow-*` flags. Switching runtimes for extensions only would add a second
runtime to ship and support.

**Same-uid subprocess with an empty environment.** It is cheaper, but it fails
goal 1 for the reason given above.

## Open questions

1. **Compose:** a separate runner service, or runner processes inside the engine
   container under a second uid? The separate service is cleaner. The second uid
   needs root at container start to drop privileges.
2. **Egress:** should it be granted per extension in the operator config, in the
   manifest (operator approves at install), or both?
3. **Memory:** is a per-extension memory budget a default with operator override,
   or fixed by tier?
4. **Should first-party extensions be able to opt into the runner** (for the ones
   that need no engine-side hooks), to shrink the trusted surface over time?
