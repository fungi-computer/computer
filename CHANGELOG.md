# @fungi.computer/computer

## 0.18.11

### Patch Changes

- Changes since 0.18.10:

  - fix(files): treat a non-executable patch engine as a platform failure
  - fix(files): say patch creates files and report a missing patch engine

- Updated dependencies
- Updated dependencies
  - @fungi.computer/computer-contract@0.6.10
  - @fungi.computer/knapsack@0.4.33

## 0.18.10

### Patch Changes

- @fungi.computer/knapsack@0.4.32
  - @fungi.computer/computer-contract@0.6.9

## 0.18.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/cairn@0.1.1
  - @fungi.computer/knapsack@0.4.31
  - @fungi.computer/computer-contract@0.6.8
  - @fungi.computer/watchdog@0.1.7
  - @fungi.computer/seam@0.2.9

## 0.18.8

### Patch Changes

- @fungi.computer/knapsack@0.4.30
  - @fungi.computer/computer-contract@0.6.7

## 0.18.7

### Patch Changes

- @fungi.computer/knapsack@0.4.29
  - @fungi.computer/computer-contract@0.6.6

## 0.18.6

### Patch Changes

- Updated dependencies
  - @fungi.computer/watchdog@0.1.6
  - @fungi.computer/seam@0.2.8
  - @fungi.computer/knapsack@0.4.28
  - @fungi.computer/computer-contract@0.6.5

## 0.18.5

### Patch Changes

- Changes since 0.18.4:

  - fix(oyster): keep setup file writes on apply_patch and name a failed patch's
    last line

## 0.18.4

### Patch Changes

- Changes since 0.18.3:

  - fix(computer): type the transport stage and bound the cause walk
  - fix(computer): name the connect stage when a hosted Computer fails to wake

- Updated dependencies
  - @fungi.computer/computer-contract@0.6.4
  - @fungi.computer/knapsack@0.4.27

## 0.18.3

### Patch Changes

- Changes since 0.18.2:

  - fix(computer): never echo a hosted runtime error and say a restarted command
    may have run
  - fix(computer): keep an unknown command's cause on replay and prove bounds on
    a VM
  - fix(computer): report why a command result is lost, not a bare unknown

- Updated dependencies
  - @fungi.computer/computer-contract@0.6.3

## 0.18.2

### Patch Changes

- @fungi.computer/knapsack@0.4.26
  - @fungi.computer/computer-contract@0.6.2

## 0.18.1

### Patch Changes

- Changes since 0.18.0:

  - fix(hub): name a Computer that stopped while starting

- @fungi.computer/knapsack@0.4.25
  - @fungi.computer/computer-contract@0.6.1

## 0.18.0

### Minor Changes

- Changes since 0.17.0:

  - feat(computer): a preview waits up to 20 s for a declared service to open
    its port
  - fix(hub): lead a failed service change with the service and its plain cause
  - feat(hub): list and manage a Computer's services on its card

## 0.17.0

### Minor Changes

- Changes since 0.16.6:

  - feat(hub): serve the declared-service tools on hosted Computers
  - feat(computer): let an Agent declare services that survive sleep
  - feat(computer): slim image with pinned fungi-tools installs
  - fix(computer): use pinned codex launcher and record release claim
  - feat(computer): preinstall languages and coding agent tools
  - fix(computer): merge current integration and retain procps
  - fix(computer): reconcile preinstalled tools with integration

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/computer-contract@0.6.0
  - @fungi.computer/watchdog@0.1.5
  - @fungi.computer/seam@0.2.7
  - @fungi.computer/knapsack@0.4.24

## 0.16.6

### Patch Changes

- Changes since 0.16.5:

  - fix(computer): end a port preview session when its viewer loses access

- Updated dependencies
  - @fungi.computer/computer-contract@0.5.11

## 0.16.5

### Patch Changes

- @fungi.computer/knapsack@0.4.23
  - @fungi.computer/computer-contract@0.5.10

## 0.16.4

### Patch Changes

- Changes since 0.16.3:

  - perf(computer): import the shell backend without the in-shell commands

- Updated dependencies
  - @fungi.computer/knapsack@0.4.22
  - @fungi.computer/computer-contract@0.5.9

## 0.16.3

### Patch Changes

- Changes since 0.16.2:

  - fix(hub): say a low host disk plainly when a Computer start is refused

## 0.16.2

### Patch Changes

- Changes since 0.16.1:

  - fix(oyster): copy the root AGENTS.md after pulling the guest
  - fix(computer): resolve an agent's relative file paths from /workspace

## 0.16.1

### Patch Changes

- Changes since 0.16.0:

  - fix(computer): never read a port refusal header on an upgrade
  - fix(computer): show a stopped computer's preview as a plain-words page

## 0.16.0

### Minor Changes

- Changes since 0.15.2:

  - fix(hub): send a failed start's reason only to readers that decode it
  - fix(hub): keep the reason a start failed on the alarm path
  - feat(computer): export the on-box vm host refusal with its status

## 0.15.2

### Patch Changes

- Updated dependencies
  - @fungi.computer/knapsack@0.4.21
  - @fungi.computer/computer-contract@0.5.8

## 0.15.1

### Patch Changes

- Changes since 0.15.0:

  - fix(hub): keep Home's instructions at /workspace/AGENTS.md so the Agent can
    edit them

## 0.15.0

### Minor Changes

- Changes since 0.14.8:

  - fix(computer): report an owner that cannot list an Agent's Vault grants
  - fix(computer): hand the Vault owner a GET with no body
  - feat(computer): give Agent commands Vault references and a vault egress lane

## 0.14.8

### Patch Changes

- Changes since 0.14.7:

  - perf(computer): load the shell module groups when a shell starts

## 0.14.7

### Patch Changes

- @fungi.computer/knapsack@0.4.20
  - @fungi.computer/computer-contract@0.5.7

## 0.14.6

### Patch Changes

- @fungi.computer/knapsack@0.4.19
  - @fungi.computer/computer-contract@0.5.6

## 0.14.5

### Patch Changes

- @fungi.computer/knapsack@0.4.18
  - @fungi.computer/computer-contract@0.5.5

## 0.14.4

### Patch Changes

- Changes since 0.14.3:

  - fix(computer): refuse same-site sibling Origin and Referer at the port gate

## 0.14.3

### Patch Changes

- @fungi.computer/knapsack@0.4.17
  - @fungi.computer/computer-contract@0.5.4

## 0.14.2

### Patch Changes

- @fungi.computer/knapsack@0.4.16
  - @fungi.computer/computer-contract@0.5.3

## 0.14.1

### Patch Changes

- @fungi.computer/knapsack@0.4.15
  - @fungi.computer/computer-contract@0.5.2

## 0.14.0

### Minor Changes

- Changes since 0.13.0:

  - fix(computer): install procps in the Computer image so Stop can end a
    session
  - fix: isolate Oyster previews and refuse sibling requests
  - fix(computer): preserve service tokens on admitted WebSocket upgrades
  - fix(oyster): open reusable preview links through owner admission
  - feat(oyster): admit private port previews through owner sessions
  - feat(computer): retain private port access tokens and sessions
  - fix(computer): align runtime named group with its numeric identity
  - feat(computer): add VM-only sudo and Docker image layer

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/cordyceps@0.4.3
  - @fungi.computer/watchdog@0.1.4
  - @fungi.computer/knapsack@0.4.14
  - @fungi.computer/computer-contract@0.5.1
  - @fungi.computer/seam@0.2.6

## 0.13.0

### Minor Changes

- Changes since 0.12.2:

  - feat(computer): add the files.remove operation for Media erase

### Patch Changes

- Updated dependencies
  - @fungi.computer/computer-contract@0.5.0

## 0.12.2

### Patch Changes

- @fungi.computer/knapsack@0.4.13
  - @fungi.computer/computer-contract@0.4.1

## 0.12.1

### Patch Changes

- Changes since 0.12.0:

  - fix(computer): upgrade a Computer store from before Computer sizes

## 0.12.0

### Minor Changes

- Changes since 0.11.0:

  - feat(computers): per-plan running limit from the price book, 1 h idle sleep
  - feat(oyster): owner Stop for a standalone Computer
  - feat(computer): ten-minute commands and detached processes Agents can read,
    wait on and stop
  - feat(agents): an Agent's instructions are AGENTS.md on its Home Computer

### Patch Changes

- Updated dependencies
  - @fungi.computer/computer-contract@0.4.0
  - @fungi.computer/knapsack@0.4.12

## 0.11.0

### Minor Changes

- Changes since 0.10.0:

  - feat(computer): weigh VM host admission by Computer size
  - feat(computer): small, default and large Computers with a published hourly
    price

### Patch Changes

- @fungi.computer/knapsack@0.4.11
  - @fungi.computer/computer-contract@0.3.1

## 0.10.0

### Minor Changes

- Changes since 0.9.0:

  - feat(computer): add the files.move operation

### Patch Changes

- Updated dependencies
  - @fungi.computer/computer-contract@0.3.0
  - @fungi.computer/knapsack@0.4.10

## 0.9.0

### Minor Changes

- Changes since 0.8.8:

  - fix(computer): drop a replay table without a backend column instead of
    upgrading it
  - fix(computer): give each local backend its own dial-replay capacity share
  - feat(computer): say a command ended because the Computer went to sleep

### Patch Changes

- Updated dependencies
  - @fungi.computer/computer-contract@0.2.0

## 0.8.8

### Patch Changes

- Changes since 0.8.7:

  - fix(hub): claim a Computer's name on every named call to it

## 0.8.7

### Patch Changes

- Changes since 0.8.6:

  - fix(oyster): learn a fleet Computer's name from its first verified grant

## 0.8.6

### Patch Changes

- Changes since 0.8.5:

  - fix(computer): learn a Computer's name from its first named call

## 0.8.5

### Patch Changes

- Changes since 0.8.4:

  - fix(hub): read a hosted Computer's name from storage, not the wake
  - fix(computer): keep a Computer's name when a redeploy wakes it by object id

## 0.8.4

### Patch Changes

- Changes since 0.8.3:

  - fix(computer): install global npm and pnpm tools into the persistent home

## 0.8.3

### Patch Changes

- Changes since 0.8.2:

  - fix(oyster): run trial Git storage in Wrangler's local simulator

## 0.8.2

### Patch Changes

- Changes since 0.8.1:

  - fix(oyster): run trial Computers in a workspace sandbox

## 0.8.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/cordyceps@0.4.2

## 0.8.0

### Minor Changes

- Changes since 0.7.0:

  - feat(computer): retain process output and serve the last lines

### Patch Changes

- Updated dependencies
  - @fungi.computer/computer-contract@0.1.0
  - @fungi.computer/knapsack@0.4.9

## 0.7.0

### Minor Changes

- Changes since 0.6.3:

  - feat(hub): delete a Computer through the Team Computers door

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @fungi.computer/cordyceps@0.4.1
  - @fungi.computer/watchdog@0.1.3
  - @fungi.computer/knapsack@0.4.8
  - @fungi.computer/computer-contract@0.0.13
  - @fungi.computer/seam@0.2.5

## 0.6.3

### Patch Changes

- Updated dependencies
  - @fungi.computer/watchdog@0.1.2
  - @fungi.computer/knapsack@0.4.7
  - @fungi.computer/computer-contract@0.0.12
  - @fungi.computer/seam@0.2.4

## 0.6.2

### Patch Changes

- Changes since 0.6.1:

  - fix(computer): prepare container images before native proof startup
  - fix(computer): wait for idle shutdown before dispatching commands

- Updated dependencies
  - @fungi.computer/watchdog@0.1.1
  - @fungi.computer/seam@0.2.3
  - @fungi.computer/knapsack@0.4.6
  - @fungi.computer/computer-contract@0.0.11

## 0.6.1

### Patch Changes

- Changes since 0.6.0:

  - fix(computer): make the unit tier hermetic and declare its Local native
    digests
  - fix(computer): partition on-box VM ingress replay history per VM

- Updated dependencies
  - @fungi.computer/seam@0.2.2

## 0.6.0

### Minor Changes

- Changes since 0.5.0:

  - feat(oyster): attach a local folder to a standalone Oyster Computer

### Patch Changes

- @fungi.computer/knapsack@0.4.5
  - @fungi.computer/seam@0.2.1
  - @fungi.computer/computer-contract@0.0.10

## 0.5.0

### Minor Changes

- Changes since 0.4.2:

  - fix(computer): decode native call results with the tool result schema
  - fix(computer): decode the operation envelope before proofs read an exit code
  - fix(hub): keep a queued Computer start until it runs or visibly fails
  - feat(computer): add the per-Computer Keep awake opt-in (HB-11)
  - feat(computer): sleep idle Computers and meter only to the last activity
    (HB-11)

### Patch Changes

- @fungi.computer/knapsack@0.4.4
  - @fungi.computer/computer-contract@0.0.9

## 0.4.2

### Patch Changes

- @fungi.computer/knapsack@0.4.3
  - @fungi.computer/computer-contract@0.0.8

## 0.4.1

### Patch Changes

- Changes since 0.4.0:

  - fix(hub): seed writable offline dependencies for native MCP proof

- @fungi.computer/knapsack@0.4.2
  - @fungi.computer/computer-contract@0.0.7

## 0.4.0

### Minor Changes

- Changes since 0.3.2:

  - feat(computer): stream tool output through Hub execution

### Patch Changes

- @fungi.computer/knapsack@0.4.1
  - @fungi.computer/computer-contract@0.0.6

## 0.3.2

### Patch Changes

- Updated dependencies
  - @fungi.computer/knapsack@0.4.0
  - @fungi.computer/computer-contract@0.0.5

## 0.3.1

### Patch Changes

- Updated dependencies
  - @fungi.computer/knapsack@0.3.1
  - @fungi.computer/computer-contract@0.0.4

## 0.3.0

### Minor Changes

- Changes since 0.2.2:

  - fix(computer): restore isolated replay-store subpath
  - fix(mesh): close relay custody review gaps
  - feat(oyster): retain offline machine-link posts
  - fix(oyster): keep Worker fleet declarations out of Node host types
  - feat(oyster): attach Agents to named Computers

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/cordyceps@0.4.0
  - @fungi.computer/knapsack@0.3.0
  - @fungi.computer/seam@0.2.0
  - @fungi.computer/computer-contract@0.0.3

## 0.2.2

### Patch Changes

- Changes since 0.2.1:

  - fix(cloudflare-computer): remove Node binary declaration globals

- Updated dependencies
  - @fungi.computer/knapsack@0.2.1
  - @fungi.computer/computer-contract@0.0.2

## 0.2.1

### Patch Changes

- Changes since 0.2.0:

  - fix(computer): read ignore rules without loading the ai-dependent tools
    entry

- Updated dependencies
  - @fungi.computer/cordyceps@0.3.1

## 0.2.0

### Minor Changes

- Changes since 0.1.0:

  - feat(stranger): typecheck each public entry in its own environment
  - fix(stranger): align the Oyster closure inventories and local dependencies
  - fix: cover Computer and Oyster packed dependency closures
  - test(computer): declare carriage observer ID arrays
  - fix(computer): keep execution lifecycle types internal
  - test(computer): verify exact retained execution identities
  - test(computer): check public context on current lifecycle rows
  - test(computer): prove scoped retention through real process owner
  - test(computer): witness exited authority before original post-pull
  - fix(computer): resolve exec replay before Workspace acquisition
  - test(computer): deny cold exec replay after actual dispatch
  - test(computer): reconcile cold processes from actual native evidence
  - test(computer): keep lost native dispatch replies closed on replay
  - test(computer): retain native authority when SIGTERM is ignored
  - fix(computer): preserve host hook causes and durable closure state
  - test(computer): use precise native proof gate and encoding types
  - test(computer): cancel pending SDK receipt with real SIGTERM
  - test(computer): cancel held host opens without native dispatch
  - test(computer): inspect only application-owned execution SQL
  - feat(computer): bind native liveness and host process carriage
  - test(computer): witness native exit before host closure
  - test(computer): carry byte stdin into the same native invocation
  - test(computer): inspect public execution cargo and SQLite secrecy
  - test(computer): replay native processes without reissuing carriage
  - test(computer): close cold exec without probing or redispatch
  - test(computer): close authority only on proven native exit
  - test(computer): fence refused starts before host closure
  - feat(computer): carry host cargo into admitted native exec
  - test(computer): require native proof before execution renewal
  - test(computer): checkpoint host-only native carriage red
  - test(computer): decode the process proof with the contract's own schemas
  - fix(stranger): register Computer and complete Puffball closure
  - feat(mesh)!: preserve caller-owned intents across Local reconnects
  - fix(mesh): intake durable Seam replay admission and its Computer consumer
  - feat(oyster): compose per-Computer Internet access controls
  - feat(hub): retire and expire temporary build Computers
  - fix(computer): bound on-box VM control requests
  - fix(computer): require hosted execution for App builds
  - fix(files): share visibility for search roots and entries
  - refactor(files): split search tools and align hosted ignore visibility
  - fix(packages): align split-package test consumers
  - refactor(computer)!: move the operation contract into computer-contract
  - refactor(shed): own the light-shell command router
  - feat(oyster): add owner fleet inventory and start controls
  - refactor(computer): share hosted fleet start orchestration
  - feat(local): shrink Files images in-process before they reach the model
  - fix(computer): make files-patch output truncation explicit
  - fix(files): one image path through the execute collector, exact signatures,
    fixed windows
  - feat(files): one find tool replaces list, glob and grep
  - feat(files): read png/jpeg/gif/webp as image parts, refuse over 3 MiB
  - fix(exec): unmistakable truncation marker, bonsai checks pin, description
    facts
  - fix(files): search real repos past .git and gitignored trees
  - fix(exec): say when command output is cut at the stream cap
  - feat(oyster): public release 0.2.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/cairn@0.1.0
  - @fungi.computer/computer-contract@0.0.1
  - @fungi.computer/cordyceps@0.3.0
  - @fungi.computer/knapsack@0.2.0
  - @fungi.computer/seam@0.1.0
  - @fungi.computer/watchdog@0.1.0

## 0.1.0

### Minor Changes

- Changes since 0.0.1:

  - perf(computer): build schemas on first use, not at import
  - feat(oyster): public release 0.1.0

### Patch Changes

- Updated dependencies
  - @fungi.computer/knapsack@0.1.0

## 0.0.1

### Patch Changes

- Initial public release of @fungi.computer/computer.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @fungi.computer/cordyceps@0.2.2
  - @fungi.computer/knapsack@0.0.2
  - @fungi.computer/seam@0.0.1
