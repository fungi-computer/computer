# @fungi.computer/computer

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
