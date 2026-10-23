# Computer runtime

This private runtime hosts one logical Fungi Computer: a SQLite-backed workspace
of files, admitted operations, and optional execution backends. The Hub composes
it with Team authorization, capacity and billing. The runtime is not an
independently installed npm VM service and does not own Team roles.

## Fleet contracts

Node tooling and browser consumers can import the grant/fact schemas and types
from `@fungi.computer/computer/fleet/wire`, and backing descriptions from
`@fungi.computer/computer/backing`. These entries do not load Worker runtime
declarations. The `./fleet` lifecycle and main Computer entry require the host
runtime's Cloudflare Workers types.

The packed stranger check exercises these Node-safe entries and the egress
helpers after a cold install of the runtime closure. The fork's companion check
parses the published shell-module groups used by the Computer image with Acorn
and checks their declarations. Neither check starts a Computer, executes a
Worker shell, or qualifies the Worker/Workspace/Git SDK in a Node type
environment.

`@fungi.computer/computer/fleet` owns the host-neutral grant check, backing
records and fact contracts. A host authenticates its caller and supplies a
`ComputerGrant`: one Computer, explicit actions, an expiry, optional host-owned
egress data, plus opaque actor/invocation provenance. `checkComputerGrant`
returns `admitted` or `Refused`; grants impose no paid-usage budget. A caller's
per-command timeout remains a command parameter enforced by the operation
executor. Hub credit enforcement remains on its existing funded/unfunded
admission and `creditChanged` → credit-publication restate/stop path.

`createFleetBacking` accepts the maintained SQLite owner. Creation records a
plain backing decision once. Explicit fleet-default and Computer overrides
remain possible; local attachment keeps replay identity, actor ownership and
detach cancellation. Mutations return complete backend projections rather than
calling a host or delivering messages. The composing host can include the call
and durable outbox staging in its SQLite transaction. Its deployment chooses the
offered backing kinds; the fleet never rereads deployment configuration.

`ComputerFact` describes process exit, file writes, egress, lifecycle and
runtime interval observations with provenance. CPU time is nullable when
unmeasured. The host reads these records and owns settlement and delivery.
Host-specific egress data is decoded by its host; the fleet contract carries
JSON data without importing the host's policy.

The fleet also owns inventory/replay receipts, running-slot storage, runtime
intervals, and native lifecycle activity/recycling. Inventory admission stays at
the host: an existing create receipt is checked before funding a new create.
Slot capacity is explicit infrastructure input; grants carry no usage cap.
`FleetLifecycle.run` checks a host-issued start grant before native execution.
The host consumes returned reservation/diagnostic facts and
`ComputerRuntimeUsage.pendingFacts` interval facts; it owns credit changes,
usage delivery, logging, and Team Git. Acknowledgment retains the existing
runtime checkpoint identity and occurs only after delivery. Transport activity,
idle sleep, and VM recycle sequencing retain the existing runtime behavior. The
Hub records creation backing facts for its declared known Computers at
initialization; the fleet never derives missing records on reads.

The Hub projects each current resource decision into a grant for the requested
Files or execution permission. It carries the stored decision's expiry and
actor/attachment identity. Native acceptance still rechecks the current Hub
decision before fleet admission; a grant is never cached across that check. The
Hub projects interval facts into its existing usage Post payload without
changing billing or credit-stop behavior.

The repository architecture test rejects upward imports from this runtime into
Apps, Billing, Broker or Team/plan modules, including type and dynamic imports.

## Source setup

Use a configured repository checkout with the pinned Node and pnpm tools. Run
from the repository root:

```sh
pnpm turbo:run run build --filter=@fungi.computer/computer
pnpm --filter @fungi.computer/computer typecheck
pnpm --filter @fungi.computer/computer lint
pnpm --filter @fungi.computer/computer test
```

The build emits the runtime and copies its daemon/build assets. The test suite
uses disposable Workers and proof containers, so container proofs require a
working local Docker/Workers environment. These commands do not deploy a Hub,
publish an App or replace a production Computer image.

## Files and operation results

[ComputerDO](src/index.ts) composes the maintained Cloudflare Workspace and
SQLite provider. Files belong to that workspace, not to a running shell process.
A file read can work with no available execution backend.

[Operation contracts](../computer-contract/README.md), in their own package,
declare discovery, bounded file reads/writes, directories, command execution,
processes and port exposure. The [Files adapter](src/files.ts) implements the
same read and compare/replace contract for Agent tools. Failed containment,
conflicting contents and reserved ports remain explicit errors.

An execution request carries a replay key. The
[operation record](src/operation-record.ts) admits the immutable input and
retains its result. Repeating that key reads the same operation rather than
silently starting it again with different content. Accepted, running, settled
and uncertain outcomes are distinct. An uncertain result is not a successful
command or proof that no side effect happened.

The Workspace is authoritative. A Files save pushes to a hosted runtime that is
already running, and a Files read pulls from it first. While a terminal is
attached, the Computer pushes and then pulls every 3 s, so the open terminal and
Files stay close to each other without either side waiting on the other. A
stopped runtime is never woken to sync; it catches up through its own push/pull
bracket on its next command or terminal attach. A failed sync stays pending in
the library's own cursors and is resent on the next sync, so it never fails the
Files operation that triggered it. There is no merge: each path takes the last
version applied. Edits to the same path on both sides between two syncs resolve
to the Workspace's version, because the loop pushes before it pulls. A
compare-and-replace save pulls first, so a newer terminal edit surfaces as an
honest conflict instead of a silent overwrite, while a blind write still
overwrites the container's copy.

## Choose an execution backend

[Backend routing](src/computer-backends.ts) owns these choices:

| Operation                             | Routing                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `exec` without a backend ID           | Built-in Worker shell.                                                                                             |
| `bash`, or execution naming a backend | The named backend, or online local folders before on-box VMs before platform containers. Attach order breaks ties. |
| Terminal, processes and ports         | Hosted backends only. A local folder cannot serve these operations.                                                |

An explicit unavailable backend never silently falls back. With no usable
backend, execution returns `no_backend` or `backend_unavailable`; workspace
Files remain separate. The backend list is bounded and IDs are unique.

[Local backends](src/local-backend.ts) connect through the member's device-key
admission and dial-out socket. Files sync with the attached folder. Commands run
with that member's OS access. [On-box VM support](src/on-box-vm.ts) adapts a
registered host to the Workspace backend interface. Platform containers use the
maintained Cloudflare container backend. Neither backend label nor a green
container fixture certifies an installed VM host or production routing.

Local dial verification binds Seam's replay-admission port to the existing
Computer Durable Object's SQLite database. That database is the receiver
namespace across reconstruction, shared by its attached devices; nonce identity
inside it is nonce-only. One native transaction prunes only strictly expired
records, refuses duplicates or the private 4,096-record ceiling, and commits the
nonce before admission succeeds. Seam owns the inclusive retention deadline;
duplicates never renew it and capacity never evicts live history. Storage
failure refuses admission without a process-local fallback. Attachment,
device-key, signature, audience and revocation authority remain unchanged.

`createLocalBackendReplayStore(owner)` is exported for another native Local-dial
receiver that uses its own existing SQLite owner, including a Team machine-link
receiver. The caller owns pins, audience, membership and revocation; this store
owns only atomic, bounded nonce retention. It neither creates a Computer nor
shares nonce history across separate databases.

`test:unit` includes the `machine-link-reopen-replay` proof: two physical Node
processes call the actual local-dial verifier against the same SQLite file. This
proves reconstructed-process replay refusal, not a complete HTTP/WebSocket
route, deployed host or container-health acceptance.

## Processes, ports and lifetime

Start requires a host-owned opaque `requestId` and `requestScope`, plus a
command, optional working directory and optional declared port. Within this
Computer, the same scope/key and immutable input return the retained process;
changed input conflicts. Replay protection lasts while its process record is
retained (at most 64 records, with 16 running **per host scope**). Another scope
cannot consume these slots or evict its replay protection. Once this scope's own
history evicts an exited record, its key can start a new process; callers must
not retry a retired command as new work. Inventory presentation lists the newest
64 records across the Computer; retained records can outlive that read window. A
retained replay never starts another command or boots a backend. A running
receipt replays as `uncertain`; liveness reads verify execution. Failed dispatch
retains an exited receipt.

App hosts derive scope from Installation, method and member/actor, separately
from the unchanged opaque invocation key. The helper uses an unambiguous JSON
tuple and labels the caller `member:<id>`, `agent:<id>` or `team-key:<id>`. One
method invocation permits one declared start: identical input is a retry,
different input conflicts. The trusted App HTTP route takes only the sealed host
method label and derives Installation and member from its admitted principal;
arbitrary requestScope is invalid. Native model capability input has only
command/cwd/port; public call mints its own native-tool scope/key. Scope strings
are replay identities, not grants.

Admission records the process and any newly created port exposure in one SQLite
transaction. Process rows carry `port` (`null` when none was declared). An
observed exit or refused dispatch removes only that process's exposure; manual
exposures remain, including an explicit manual re-expose. Request/frame
cancellation after host dispatch does not cancel Computer-owned work.

[Process inventory](src/process-inventory.ts) retains owner-issued identities
and reports running, exited or uncertain state. Worker reconstruction and
backend termination are different events. A reachable backend can preserve a
process across Worker reconstruction; a sleeping or stopped backend does not
keep that process alive.

Ordinary command execution is bounded to two minutes. Long-running work uses
process operations. Port exposure is explicit and bounded. Ports 8080 and 7681
belong to Computer control/terminal daemons and cannot be application previews.
The Hub owns preview admission and URLs; this runtime does not expose arbitrary
Computer control endpoints to the browser.

[Container policy](src/container-policy.ts) configures idle sleep and respects
`HOSTED_COMPUTERS`. Invalid pause settings fail closed. Network access follows
the host's admitted egress composition; a native container binding and the
on-box host adapter are separate configuration paths.

## Image and build inputs

The [Dockerfile](Dockerfile) builds the Linux environment with pinned Node,
pnpm, Git, FUSE support and the bundled computerd. Its
[container manifest](container/package.json) owns the PTY and runtime
dependencies. [computer-init](container/computer-init.mjs) supervises computerd
and the terminal server. Initialization mounts before dropping privileges; the
image removes setuid/setgid helpers. Terminal shell assets live under
[container/terminal-assets](container/terminal-assets).

The [Forage dependency fixture](test/forage-dependencies/README.md) describes an
offline dependency layer and its exact source manifest. It is a reproducible
build fixture, not another runtime package or evidence that generated outputs
were saved in a hosted Computer. Do not copy its temporary output into source.

## Proof and reference

[package.json](package.json) declares the private entrypoints `.` and `./files`,
`./backing`, `./host-config`. Operation schemas come from
`@fungi.computer/computer-contract`. [Runtime proof](test/runtime-proof.mjs)
checks native workspace operations and reconstruction.
[Process proof](test/process-proof.mjs) checks retained process identity against
the real container. [Terminal proof](test/terminal-container-proof.mjs),
[resource proof](test/container-resource-proof.mjs) and
[backend tests](test/computer-backends.test.mjs) cover their separate
boundaries. The declared nightly egress proof is separate from the ordinary
package test. No local proof alone qualifies a production or celld/on-box
deployment.

### Post-command Workspace transport

The Computer's remote-backend adapter observes the backend's closed-connection
signal and classifies failed RPC calls and streams as transport failures
understood by `@cloudflare/computer`. It does not inspect exception text. The
library retains its existing one-reconnect bound and finishes the post-command
pull against the same runtime. The adapter adds no retry loop, never replays an
uncertain command, and leaves failed synchronization pending. Public consumers
use the unpatched dependency. `node --test test/workspace-sync.test.mjs`
exercises that installed Workspace runtime and SQLite filesystem, including
persisted file bytes, persistent failure, domain failure, runtime replacement
and uncertain dispatch.

### Port previews

`@fungi.computer/computer/preview` owns bounded, signed preview tickets and
service-relative routing. The host supplies its selector decoder, hostname
policy and live admission callback. Admission runs at the exposed-port listing
and forwarding acceptance points; a ticket is never a grant. Hub retains its
local App projection and signed-ticket hostname configuration.
