# RFC: third-party extensions run out of process

Status: **accepted** (owner, 2026-10-06). The open questions are settled under
[Decisions](#decisions). Steps 2 (transport), 3 and 3b (bare-metal runner, one per extension), 4
(container runner) and 5 (edge functions, opt-in) are done. Decision 5 (2026-10-09,
from a measured experiment) keeps first-party extensions inline and puts three
steps before the default flip: a faithful SQL bridge (6), the same `ctx` contract
out of process as inline (7) and one database transaction per request across the
bridge (8). Step 6 is next.

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
| Bare metal (single binary) | One systemd service per extension, `zveltio-ext-runner@<instance>`, with `DynamicUser=yes`. The engine starts it through polkit and connects to its unix socket (steps 3, 3b). | A uid per extension (so the engine's files, environment and process state, and other extensions, are out of reach), the unit's sandbox (`TemporaryFileSystem`, `ProtectProc=invisible`, `IPAddressDeny`) and its cgroup limits. |
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

`lib/edge-functions/subprocess-runner.ts` spawns a process per invocation with a
minimal environment and a memory ceiling, by default under the engine's uid.
With `ZVELTIO_EDGE_TRANSPORT=runner` it runs on the same runner placement
instead, which closes the same-uid gap for edge functions too (step 5).

## Migration plan

0. **Done in #906:** the production opt-in for worker extensions, and corrected
   documentation.
1. **Done:** this RFC is accepted and its open questions settled (2026-10-06).
2. **Done — transport:**
   - `lib/worker-extension-transport.ts`: 4-byte big-endian length + UTF-8 JSON
     frames (32 MiB cap) over the child's stdin/stdout, selected by
     `ZVELTIO_EXT_TRANSPORT=process`; the in-thread worker stays the default and
     the development transport. stdout belongs to the runtime: an extension's
     `console.log` and `process.stdout.write` are redirected, and a raw write to
     fd 1 corrupts the channel, which ends the runner (respawned like a crash);
   - `tests/harness/worker-transport-contract.test.ts` runs the same extension
     over both transports and expects identical transcripts.
3. **Done — bare-metal runner** (owner decision 2026-10-08):
   - `zveltio ext-runner` (`lib/ext-runner.ts`) is its own systemd service,
     `zveltio-ext-runner`, started as the `zveltio-ext` user. The engine keeps
     `NoNewPrivileges=yes`, so it cannot start a process under another uid; it
     connects to the runner's unix socket instead
     (`ZVELTIO_EXT_TRANSPORT=runner`, `ZVELTIO_EXT_RUNNER_SOCKET`). One
     connection is one extension process; the runner pipes the #979 frames
     between the connection and the process unchanged, kills the process when
     the connection closes and closes the connection when the process exits.
   - The runner serves only the engine's uid, read from the kernel with
     SO_PEERCRED (`bun:ffi` `getsockopt`: Bun exposes neither the option nor a
     way to listen on a socket systemd created). It refuses to run as the
     engine's uid or as root.
   - Limits: each process gets RLIMIT_AS (`ZVELTIO_EXT_MEMORY_MB`, floor and
     default 1024 — Bun does not start under it); the unit's `MemoryMax` and
     `TasksMax` bound all of them together.
   - The unit (written by `install/install.sh` for binary installs) shows the
     runner only the binary and the extensions directory of `ZVELTIO_DIR`
     (`TemporaryFileSystem` + `BindReadOnlyPaths`), hides other users' processes
     (`ProtectProc=invisible`) and denies every IP address (`IPAddressDeny=any`)
     until the operator allows one with `systemctl edit zveltio-ext-runner`. The
     installer also makes `storage/` `0700`; `.env` was already `0600`.
   - With the runner transport, the #906 production opt-in is not asked for:
     the boundary it stood in for exists.
   - `packages/engine/scripts/ext-runner-isolation.sh` (CI job *Extension runner
     isolation*) runs a probe extension in a container with a real uid boundary.
     Over the `process` transport (the engine's uid) it reads the engine's `.env`
     and `/proc/<engine pid>/environ`, which proves the probe works; over the
     runner it gets `EACCES` on both; a connection from a uid other than the
     engine's is refused.

3b. **Done — one runner per extension** (owner decision 2026-10-08), closing
   what step 3 left open:
   - `zveltio-ext-runner@<instance>.service`, a template with
     `DynamicUser=yes`: every extension has its own uid, its own cgroup
     (`MemoryMax=1G` by default — decision 3, override with
     `systemctl edit zveltio-ext-runner@<instance>`) and its own egress rule
     (`IPAddressDeny=any`, opened per extension with `IPAddressAllow` —
     decision 2). The instance is the extension name reduced to `[a-z0-9_]`
     plus 8 hex of its SHA-256: an escaped name (`\x2d`) breaks
     `RuntimeDirectory=%i`.
   - The engine starts the instance on enable and stops it on disable with
     `systemctl`, over D-Bus. A polkit rule lets the engine user start, stop
     and restart `zveltio-ext-runner@*` units and nothing else, so the engine
     keeps `NoNewPrivileges` and needs no capability.
   - Each runner directory (`/run/zveltio-ext/<instance>`) belongs to that
     instance's uid, so one extension cannot replace another's socket, and
     extensions cannot signal each other. The step 3 shared `zveltio-ext`
     user and single unit are gone.
   - `zveltio ext-runner setup --engine-user <u> --dir <d>` writes the template
     unit, the polkit rule and the engine drop-in
     (`ZVELTIO_EXT_TRANSPORT=runner`). `install.sh` and `update.sh` both run
     it, so existing installs get the runner on their next update.
   - `packages/engine/scripts/ext-runner-systemd.sh` (CI job *Extension runner
     on systemd*, a real systemd with sudo) asserts:
     - the probe over `process` reads both secrets and reaches the network;
     - the runner reaches neither and no address;
     - `IPAddressAllow` opens one extension and not the other;
     - two extensions run under two uids, and one cannot write into the
       other's runner directory;
     - the engine user can manage its runners and no other unit.
   - Inter-extension services stay brokered by the engine (`service:call` →
     `service:invoke`); runners never talk to each other.
   - Still open: approving egress from the manifest at install (decision 2) is
     manual — the operator writes `IPAddressAllow`.

4. **Done — container runner:**
   - Compose: the opt-in overlay `docker-compose.ext-runner.yml` adds one
     `ext-runner` container beside the engine. It shares only two volumes with
     it: the socket directory and the extensions (read-only). It has none of
     the engine's environment, `network_mode: none`, a read-only root, and
     `no-new-privileges`. The engine sets `ZVELTIO_EXT_TRANSPORT=runner` and
     `ZVELTIO_EXT_RUNNER_SOCKET` and connects to that socket; there is no
     systemd to start an instance, and closing the connection ends the process.
   - A uid per extension, as 3b has: there is one runner, so the runner gives
     it. It starts as root with only `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL`
     and runs every process through `setpriv` under a uid of its own from
     `ZVELTIO_EXT_RUNNER_UID_BASE` up. Bun's `spawn` ignores its `uid` option
     without a word (measured: the child ran as root). Without CAP_KILL,
     `kill()` on another uid threw EPERM and took the runner down with every
     extension (measured; the runner now logs it instead).
     Without a uid per extension, one extension could replace the runner's
     socket and be handed the next extension's channel, and with it that
     extension's `db:query` role. For the same reason the socket directory and
     `/tmp` (where the runner writes the runtime) must belong to root: the
     runner closes the first to 0755 and gives the second the sticky bit,
     and refuses to start otherwise. A Kubernetes `emptyDir` is 0777 with no
     sticky bit, which would let an extension rename the runtime's directory
     and plant its own runtime for the next one. `chmod(1)` does it: Bun's
     `chmodSync` drops the sticky bit without a word (measured).
   - Helm: `extRunner.enabled` adds the same runner as a sidecar (an
     `emptyDir` for the socket, the PVC's `extensions/` read-only,
     `RuntimeDefault` seccomp). **Limit:** a sidecar shares the pod's network,
     so the pod's NetworkPolicy is also the extensions' egress policy; a
     separate Deployment would need a network transport with its own
     authentication, since SO_PEERCRED only works on one host. The sidecar
     needs the `baseline` Pod Security level, not `restricted` (root, added
     capabilities).
   - `packages/engine/scripts/ext-runner-compose.sh` (CI job *Extension runner
     isolation*) runs the probe against the overlay itself, with only the
     runner image swapped for Bun + source. Under the engine's uid the probe reads
     the `.env`, the environment and a public URL; through the runner it reads
     none of them. It also checks that two extensions run under two uids
     ≥ the base, that neither can write into the socket directory, that the
     runner closed it and `/tmp` (both handed over 0777, as an `emptyDir`
     is), that no extension process
     outlives its connection, and that a foreign uid is refused.
   - Egress in compose is all or nothing for the runner: per-extension rules
     (decision 2) exist on bare metal only.
5. **Done — edge functions on the runner** (opt-in, `ZVELTIO_EDGE_TRANSPORT=runner`):
   - One connection is one invocation. The engine writes a header line,
     `EDGE <memory MiB> <cpu s>`, then the envelope it would have written to a
     local child. The runner tells this from an extension's channel by the
     first byte (a frame starts with its length's top byte, at most `0x02`
     under the 32 MiB cap), spawns the same generated bootstrap under the same
     `ulimit` ceilings, feeds it the envelope, and answers one JSON line with
     what a local spawn would have observed: stdout, stderr, exit code, signal
     and CPU seconds. The engine builds the `RunResult` from it with the same
     code as for a local child, so callers (the edge route, flow scripts) see
     the same results, logs and failure messages. The engine's wall-clock kill
     closes the connection, and the runner kills the process.
   - Placement: on bare metal the `zveltio-ext-runner@edge` instance (a name
     `runnerInstance` cannot produce), started on the first invocation and
     again after a failed one; `setup` gives it `TasksMax=512`, since a Bun
     process is about ten tasks. In containers, the shared runner, which runs
     each invocation under a uid of its own, as it does an extension.
   - Its own switch: `ext-runner setup` already sets `ZVELTIO_EXT_TRANSPORT`
     on every bare-metal install, and the runner denies every address, so
     reusing it would have cut edge functions off the network on the next
     update. The default stays the local child until step 6.
   - Proof: `ext-runner-compose.sh` runs `scripts/edge-runner-isolation.ts`
     through `runEdgeFunctionInSubprocess`. As the engine's child the function
     reaches a public URL; on the runner it does not. The function is held
     alive while the script finds its process from outside, takes its uid
     (≥ the base, not the engine's) and checks that this uid cannot read the
     engine's 0600 `.env`, which its owner can. The function itself reads
     nothing: since #1002 the JS lockdown leaves it no way to the filesystem,
     and the uid boundary is what holds when that lockdown fails.
     `ext-runner-systemd.sh`
     checks the same on the `edge` instance; `edge-runner-transport.test.ts`
     checks that both transports return the same results and that the
     wall-clock kill leaves no process behind.
   - Still open:
     - no per-invocation cgroup on the runner: a budget under 1024 MiB is
       floored to the RLIMIT_AS minimum, and the instance's `MemoryMax` bounds
       all invocations together;
     - no pre-spawned pool on the runner: each invocation pays the spawn
       (~30 ms) the local pool saves;
     - on bare metal every invocation shares the `edge` instance's uid, so two
       invocations running at once are not isolated from each other (in
       containers each gets its own uid);
     - egress is the runner's: closed until the operator opens the `edge`
       instance or the runner container's network.
6. **A faithful SQL bridge.** Measured in the
   [experiment](rfc-extension-runner-experiment.md): today the bridge
   - passes JS arrays to Postgres unconverted (`malformed array literal`), where
     the inline driver encodes them;
   - drops the SQLSTATE (`new Error(message)`), so a unique violation the
     extension maps to 400 becomes a 500;
   - returns rows only, so an UPDATE/DELETE without RETURNING reports 0 affected;
   - logs worker errors as `{}`;
   - and every worker extension is spawned twice at boot (registered into a
     temporary app, then again).
   These are defects for third-party extensions now; fix them first.
7. **One `ctx` contract, inline and out of process.** A worker extension gets a
   `{ query() }` instead of Kysely, no `auth` (session or API key), no
   `checkPermission`, no `events`, no `config`, and a `services.get` that calls
   instead of returning the function. An extension must not need to know where it
   runs: the worker side gets the same surface, each capability carried over the
   broker with the same rules it has inline. What cannot cross the boundary
   (field types, engine-side hooks, `ctx.internals`) is refused at load with a
   clear error, not discovered as a 500.
8. **One transaction per request across the bridge.** Each bridged statement runs
   today in its own host transaction (≈7 database round-trips where inline does 1)
   and BEGIN/COMMIT/SAVEPOINT are refused, so a multi-statement write is not
   atomic: in the experiment an invoice number was burned (a gap in a fiscal
   series) and an orphan contact was left behind. The host opens the request's
   transaction on the first statement, keeps it on a reserved connection for the
   request, maps `db.transaction()` to savepoints, and commits or rolls back
   with the response — with a hard timeout and a release on connection loss.
   This also removes most of the per-statement overhead.
9. **Default flip:** production uses the runner for third-party extensions, and
   the in-thread worker is removed: development uses the runner protocol over a
   local child (`ZVELTIO_EXT_TRANSPORT=process`), so there are two mechanisms,
   inline for trusted code and the runner for everything else. The #906 opt-in
   variable goes with the in-thread worker.
10. **Edge functions default to the runner** once egress approval (decision 2)
    exists for them; until then the runner's closed network would cut off every
    edge function that calls out.

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

## Decisions

The owner settled the four open questions on 2026-10-06; decision 5 followed on 2026-10-09.

1. **Compose: a separate runner service.** The `zveltio-ext-runner` service from
   the table above is the compose target. No second uid inside the engine
   container, so nothing needs root at container start.
2. **Egress: the manifest requests it, the operator approves it.** An extension
   declares the hosts it needs in its manifest. At install, the operator approves
   them; nothing is reachable until then. The approved list is what the network
   policy (container) or the per-uid firewall rule (bare metal) enforces.
3. **Memory: a default per extension, with operator override.** Every runner gets
   the same default budget. The operator can raise or lower it per extension in
   the extension's config. There are no tiers.
4. **First-party extensions may opt into the runner.** The ones that need no
   engine-side hooks can run out of process too, which shrinks the trusted
   surface over time. Opting in is the extension's choice; staying in process
   remains allowed for first-party code.

5. **First-party extensions stay inline (2026-10-09, revises 4).** Measured on
   sms, crm and finance/invoicing — the easiest candidates of the 55, none uses
   `ctx.internals` or an in-transaction hook ([experiment](rfc-extension-runner-experiment.md)):
   out of process they did not work at all on today's engine; with a shim they ran
   at 1.8–2.7x the p50 latency, each cost 50–65 MB RSS idle while the engine saved
   13–16 MB, and multi-statement writes lost atomicity. Thirty more first-party
   extensions also use `ctx.internals` or in-transaction hooks. The runner is the
   boundary for code the operator does not trust — third-party extensions and edge
   functions. First-party code is trusted like the engine; its real exposure is
   its npm dependencies, which a dependency policy covers (pinned lockfile, no
   install scripts, `bun audit` in CI), not a process boundary. Opting a
   first-party extension into the runner stays possible once steps 6–8 make the
   contract equal, and is then a per-extension choice backed by a measurement.

The questions, as they were asked:

1. **Compose:** a separate runner service, or runner processes inside the engine
   container under a second uid? The separate service is cleaner. The second uid
   needs root at container start to drop privileges.
2. **Egress:** should it be granted per extension in the operator config, in the
   manifest (operator approves at install), or both?
3. **Memory:** is a per-extension memory budget a default with operator override,
   or fixed by tier?
4. **Should first-party extensions be able to opt into the runner** (for the ones
   that need no engine-side hooks), to shrink the trusted surface over time?
