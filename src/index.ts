import {
  getWorkspace,
  SQLiteWorkspaceProvider,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceRegisteredBackend,
  type WorkspaceRuntimeExecHandle,
  type WorkspaceRuntimeExecOptions,
  type WorkspaceStubHost,
} from "@fungi.computer/cloudflare-computer";
import {
  WorkerShellBackend,
  type WorkerShellBackendOptions,
} from "@fungi.computer/cloudflare-computer/backends/worker-shell";
import jqCommands from "@fungi.computer/cloudflare-computer/shell/jq";
import yqCommands from "@fungi.computer/cloudflare-computer/shell/yq";
import xanCommands from "@fungi.computer/cloudflare-computer/shell/xan";
import fileCommands from "@fungi.computer/cloudflare-computer/shell/file";
import {
  withWorkspaceContainer,
  type IWorkspaceContainerAPI,
} from "@fungi.computer/cloudflare-computer/backends/container";
import { DurableObject } from "cloudflare:workers";
import type { FilesPort } from "@fungi.computer/knapsack";
import { z } from "zod";
import { SystemTrustContainerBackend } from "./container-system-trust.js";
import { computerTransportBackend } from "./transport-backend.js";
import { PullPendingTracker } from "./pull-pending.js";
import {
  ComputerFileConflict,
  ComputerFileRangeError,
  ComputerFileTooLargeError,
  capabilityNameSchema,
  computerValueSchema,
  computerCapabilities,
  computerPortInputSchema,
  computerPortOutputSchema,
  computerPortRemovalOutputSchema,
  computerPortsOutputSchema,
  computerPortSchema,
  ComputerPortLimitError,
  ComputerPortReservedError,
  computerTerminalPort,
  isComputerReservedPort,
  maximumExposedPorts,
  maximumProcessRecords,
  execInputSchema,
  execOutputSchema,
  computerToolResult,
  computerExecutionRequestSchema,
  genericComputerExecutionBudget,
  type ComputerExecutionBudget,
  mintComputerRequestId,
  type ComputerExecRequest,
  type ComputerOperationResult,
  listInputSchema,
  listOutputSchema,
  maximumFileBytes,
  maximumStreamBytes,
  mkdirInputSchema,
  mkdirOutputSchema,
  readInputSchema,
  readBytesInputSchema,
  readOutputSchema,
  replaceInputSchema,
  type ComputerExecInput,
  type ComputerFileReadInput,
  type ComputerFileByteReadInput,
  type ComputerFileReplacement,
  type ComputerFileReplacementResult,
  type ComputerValue,
  writeInputSchema,
  writeOutputSchema,
  processIdInputSchema,
  processKillOutputSchema,
  processListOutputSchema,
  processStartInputSchema,
  processStartToolInputSchema,
  ComputerProcessNotFoundError,
  type ComputerProcess,
  type ComputerProcessId,
  type ComputerProcessSync,
} from "./operation-contract.js";

import { createWorkspaceFilesPort, readBoundedWorkspaceText } from "./files.js";
import { computerExecutionResult } from "./execution-result.js";
import { ComputerOperationRecord } from "./operation-record.js";
import { applyWorkspacePatch } from "./files-patch.js";
import {
  ComputerProcessInventory,
  drainProcessExit,
  observeProcess,
  type ProcessObservation,
  type ProcessRuntime,
} from "./process-inventory.js";
import {
  assertComputerContainersEnabled,
  computerContainerSleepAfterMs,
  ComputerContainersPausedError,
  configureComputerContainer,
  hostedComputerContainersPaused,
} from "./container-policy.js";
import {
  OnBoxVmContainerHost,
  onBoxVmPlacement,
  type OnBoxVmEnv,
  type OnBoxVmPlacement,
} from "./on-box-vm.js";
import {
  attachedBackendId,
  describeAttachedBackend,
  routeComputerBackend,
  type AttachedBackend,
  type AttachedBackendView,
  type BackendNeed,
  type BackendRoute,
  type ContainerRuntimeStart,
  type HostedBacking,
  type LocalBackend,
} from "./computer-backends.js";
import { MeteredContainerHost } from "./metered-container-host.js";
import {
  LocalBackendConnections,
  LocalWorkspaceBackend,
  localBackendDialPath,
  verifyLocalBackendDial,
} from "./local-backend.js";

const computerBinding = "COMPUTER";
const utf8 = new TextEncoder();
const terminalDefaultCols = 80;
const terminalDefaultRows = 24;
/** How often an attached terminal's container changes reach the Workspace. */
const terminalSyncIntervalMs = 3_000;
const terminalSessionsSchema = z.lazy(() =>
  z.strictObject({
    attached: z.number().int().nonnegative(),
  }),
);
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const terminalQuerySchema = z.lazy(() =>
  z.strictObject({
    session: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    cols: z.coerce.number().int().min(2).max(500).catch(terminalDefaultCols),
    rows: z.coerce.number().int().min(2).max(300).catch(terminalDefaultRows),
  }),
);

/** The exact RPC surface of one Computer Durable Object. */
export type ComputerRpc = WorkspaceStubHost &
  Readonly<{
    getCapabilities: ComputerDO["getCapabilities"];
    call: (
      capabilityId: ComputerValue,
      input: ComputerValue,
    ) => Promise<ComputerValue>;
    readFile: (
      input: ComputerFileReadInput,
    ) => Promise<ReadableStream<Uint8Array>>;
    writeFile: (
      input: ComputerFileReadInput,
      content: ReadableStream<Uint8Array>,
    ) => Promise<void>;
    exposePort: (input: {
      port: number;
    }) => Promise<{ port: number; exposed: boolean }>;
    listPorts: () => Promise<{ ports: number[] }>;
    unexposePort: (input: {
      port: number;
    }) => Promise<{ port: number; removed: boolean }>;
    replaceFileIfUnchanged: (
      input: ComputerFileReplacement,
    ) => Promise<ComputerFileReplacementResult>;
  }>;

/** The Cloudflare binding projection needed to select one named Computer. */
export type ComputerNamespace = Readonly<{
  getByName: (name: string) => ComputerRpc;
}>;

function entryType(entry: {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}): "file" | "directory" | "symlink" {
  if (entry.isFile) return "file";
  if (entry.isDirectory) return "directory";
  return "symlink";
}

function truncate(value: string) {
  const bytes = utf8.encode(value);
  if (bytes.byteLength <= maximumStreamBytes) {
    return { value, truncated: false };
  }
  return {
    value: new TextDecoder().decode(bytes.slice(0, maximumStreamBytes)),
    truncated: true,
  };
}

async function read(workspace: Workspace, input: ComputerValue) {
  const { path } = readInputSchema.parse(input);
  const stat = await workspace.fs.stat(path);
  if (!stat.isFile) throw new Error(`Computer path is not a file: ${path}`);
  if (stat.size > maximumFileBytes) {
    throw new Error("File exceeds the Computer read bound");
  }
  return readOutputSchema.parse({
    path,
    content: await workspace.fs.readFile(path, "utf8"),
  });
}

async function list(workspace: Workspace, input: ComputerValue) {
  const { path, limit, offset } = listInputSchema.parse(input);
  const rows = await workspace.fs.readdir(path, {
    limit: limit + 1,
    offset,
  });
  return listOutputSchema.parse({
    path,
    entries: rows.slice(0, limit).map((entry) => ({
      name: entry.name,
      size: entry.size,
      modifiedAt: entry.mtime,
      type: entryType(entry),
    })),
    nextOffset: rows.length > limit ? offset + limit : null,
  });
}

async function mkdir(workspace: Workspace, input: ComputerValue) {
  const { path, recursive } = mkdirInputSchema.parse(input);
  await workspace.fs.mkdir(path, { recursive });
  return mkdirOutputSchema.parse({ path });
}

async function write(workspace: Workspace, input: ComputerValue) {
  const { path, content } = writeInputSchema.parse(input);
  await workspace.fs.writeFile(path, content);
  return writeOutputSchema.parse({
    path,
    bytes: utf8.encode(content).byteLength,
  });
}

async function exec(
  workspace: Workspace,
  input: ComputerExecInput,
  backend: string | undefined,
  signal?: AbortSignal,
) {
  // The host request has already been decoded under its admitted budget.
  const { command, cwd, timeoutMs } = input;
  const backendOption = backend === undefined ? {} : { backend };
  const options =
    cwd === undefined
      ? { encoding: "utf8" as const, timeoutMs, ...backendOption }
      : { encoding: "utf8" as const, timeoutMs, cwd, ...backendOption };
  using run = await workspace.runtime.exec(command, options);
  const result = await computerExecutionResult(run, signal);
  const synchronizationFailure =
    result.sync.status === "pending"
      ? `Computer command filesystem synchronization failed: ${result.sync.error}`
      : null;
  const stdout = truncate(result.stdout);
  const stderr = truncate(
    synchronizationFailure === null
      ? result.stderr
      : `${synchronizationFailure}${result.stderr.length === 0 ? "" : `\n${result.stderr}`}`,
  );
  return execOutputSchema.parse({
    status: synchronizationFailure === null ? result.status : "failed",
    exitCode:
      synchronizationFailure !== null && result.exitCode === 0
        ? 1
        : result.exitCode,
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated,
  });
}

/** The liveness probe reads computerd executions on one hosted backend. */
function processRuntime(workspace: Workspace, backend: string): ProcessRuntime {
  return {
    getExec: (id, options) =>
      workspace.runtime.getExec(id, { ...options, backend }),
  };
}

/** Cloudflare bindings required by the first durable Computer host. */
export type ComputerEnv = OnBoxVmEnv &
  Readonly<{
    /** Host-supplied native loopback binding; not a process environment variable. */
    COMPUTER_EGRESS?: (options: {
      props: { computerObjectId: string };
    }) => Fetcher;
    /** Platform kill switch for container-backed Computer operations. */
    HOSTED_COMPUTERS?: string;
    LOADER?: NonNullable<WorkerShellBackendOptions["loader"]>;
  }>;

/** A command could not be placed on an attached backend. */
export class ComputerBackendUnavailableError extends Error {
  constructor(readonly code: "no_backend" | "backend_unavailable") {
    super(
      code === "no_backend"
        ? "No attached Computer backend is available"
        : "The named Computer backend is not available",
    );
    this.name = "ComputerBackendUnavailableError";
  }
}

class ComputerDurableObject extends DurableObject<ComputerEnv> {
  get bindings(): ComputerEnv {
    return this.env;
  }

  get state(): DurableObjectState {
    return this.ctx;
  }
}

const ContainerComputerBase = withWorkspaceContainer(ComputerDurableObject);

/** One Workspace built for one attached-backend set. */
/** The directory every Computer backend mounts as its guest workspace. */
const workspaceMountRoot = "/workspace";
type WorkspaceGeneration = Readonly<{
  key: string;
  workspace: Workspace;
  containers: ReadonlyMap<string, SystemTrustContainerBackend>;
}>;

/** A VM's container upgrade, rewritten by the verified on-box ingress door. */
const vmUpgradePath = /^\/__vm\/([a-z0-9][a-z0-9-]{0,62})(\/ws)$/;

/**
 * The Computer owns its Workspace. `@cloudflare/computer` fixes a Workspace's
 * backends when it is constructed, so the Workspace is rebuilt whenever the
 * attached set changes; the previous generation is closed and a command still
 * running on it ends as a transport failure. A local machine connecting or
 * leaving changes status, not the set, and rebuilds nothing.
 */
class ContainerComputer extends ContainerComputerBase {
  readonly #onBoxVms = new Map<string, OnBoxVmContainerHost>();
  #generation: WorkspaceGeneration | undefined;
  readonly #rootedWorkspaces = new WeakSet<Workspace>();
  /** Parked dial-ins from attached machines; survives Workspace rebuilds. */
  readonly localConnections = new LocalBackendConnections((id) => {
    this.state.waitUntil(this.#catchUpLocal(id));
  });
  /**
   * Preserves `@cloudflare/computer`'s own pull-retry capability (its
   * `retryScheduler` option) across every Workspace generation: whoever
   * later wires a Durable Object alarm to `Workspace.retryPendingSync`
   * needs its real, dedup'd-by-runtime intents, not a stand-in. Per-exit
   * sync status is attributed per drain instead (`drainProcessExit`,
   * `observeSync`), not read from this tracker.
   */
  readonly #pullPending = new PullPendingTracker();

  constructor(ctx: DurableObjectState, env: ComputerEnv) {
    super(ctx, env);
    if (
      ctx.container === undefined ||
      hostedComputerContainersPaused(env.HOSTED_COMPUTERS)
    )
      return;
    ctx.waitUntil(configureComputerContainer(ctx.container));
  }

  public override getWorkspaceContainer() {
    assertComputerContainersEnabled(this.bindings.HOSTED_COMPUTERS);
    return super.getWorkspaceContainer();
  }

  /**
   * This Computer's attached backends, in attach order. The standalone
   * runtime attaches its Worker's default host; a Computer owner (Hub)
   * overrides this with the list its Team projected down.
   */
  protected attachedBackends(): readonly AttachedBackend[] {
    const hostId = this.bindings.COMPUTER_VM_DEFAULT_HOST;
    return [
      hostId === undefined
        ? { kind: "platform-container" }
        : { kind: "on-box-vm", hostId },
    ];
  }

  /**
   * A machine that dials in catches up without waiting for a command. The
   * Computer wins (Levi, 2026-09-28): push the Workspace's changes first, so
   * a path changed or deleted on both sides takes the Computer's version,
   * then pull what only the folder changed. A command brackets the same way.
   */
  async #catchUpLocal(id: string): Promise<void> {
    try {
      const workspace = await this.readyWorkspace();
      await workspace.push(id);
      await workspace.pull(id);
    } catch (error) {
      throw new Error(`Local Computer backend ${id} catch-up failed`, {
        cause: error,
      });
    }
  }

  /** Accept a verified dial-in from an attached machine and park it. */
  async #acceptLocalDial(
    request: Request,
    computerName: string,
    backendId: string,
  ): Promise<Response> {
    const backend = this.attachedBackends().find(
      (candidate): candidate is LocalBackend =>
        candidate.kind === "local" &&
        attachedBackendId(candidate) === backendId,
    );
    if (
      backend === undefined ||
      computerName !== this.state.id.name ||
      !(await verifyLocalBackendDial(request, computerName, backend))
    )
      return new Response(null, { status: 404 });
    // A verified plain request lets the machine tell attached from detached.
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    // Registering the backend first keeps its id in this generation.
    this.workspace();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.localConnections.park(backendId, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A runtime of a hosted backend started; owners meter it. */
  protected containerRuntimeStarted(start: ContainerRuntimeStart): void {
    void start;
  }

  /** The single routing decision over this Computer's attached backends. */
  protected routeBackend(
    backend: string | undefined,
    need: BackendNeed,
  ): Extract<BackendRoute, { kind: "routed" }> {
    const route = routeComputerBackend(
      this.attachedBackends(),
      (id) => this.localConnections.online(id),
      { backend, need },
    );
    if (route.kind !== "routed")
      throw new ComputerBackendUnavailableError(route.kind);
    return route;
  }

  /**
   * The hosted backend that terminals, processes and ports use: the first in
   * the default order, or none when only local machines are attached.
   */
  protected hostedRoute():
    Readonly<{ id: string; backing: HostedBacking }> | undefined {
    const route = routeComputerBackend(this.attachedBackends(), () => false, {
      need: "hosted",
    });
    if (route.kind !== "routed" || route.backend.kind === "local")
      return undefined;
    return { id: route.id, backing: route.backend };
  }

  /** The hosted route, or the typed failure a caller maps to unavailable. */
  protected requireHostedRoute(): Readonly<{
    id: string;
    backing: HostedBacking;
  }> {
    const route = this.hostedRoute();
    if (route === undefined)
      throw new ComputerBackendUnavailableError("no_backend");
    return route;
  }

  /** This Computer's attached backends with their live status. */
  protected describeBackends(): AttachedBackendView[] {
    return this.attachedBackends().map((backend) =>
      describeAttachedBackend(
        backend,
        this.localConnections.online(attachedBackendId(backend)),
      ),
    );
  }

  /** The metered container host behind one hosted backend. */
  protected hostedContainerHost(
    backing: HostedBacking,
  ): IWorkspaceContainerAPI {
    const host =
      backing.kind === "platform-container"
        ? this.getWorkspaceContainer()
        : this.onBoxVmHost(backing.hostId);
    return new MeteredContainerHost(host, backing, (start) => {
      this.containerRuntimeStarted(start);
    });
  }

  /** The on-box VM host service for `hostId`, one per placement. */
  protected onBoxVmHost(hostId: string): OnBoxVmContainerHost {
    assertComputerContainersEnabled(this.bindings.HOSTED_COMPUTERS);
    const placement: OnBoxVmPlacement | undefined = onBoxVmPlacement(
      this.bindings,
      hostId,
    );
    if (placement === undefined)
      throw new Error(`Computer VM host ${hostId} is not registered`);
    let host = this.#onBoxVms.get(hostId);
    if (host === undefined) {
      host = this.createOnBoxVmHost(placement);
      this.#onBoxVms.set(hostId, host);
    }
    return host;
  }

  /** Let the consuming owner admit boots while preserving the runtime host seam. */
  protected createOnBoxVmHost(
    placement: OnBoxVmPlacement,
  ): OnBoxVmContainerHost {
    return new OnBoxVmContainerHost(
      placement,
      this.bindings,
      this.state.id.toString(),
      computerContainerSleepAfterMs,
    );
  }

  /** Whether a hosted backend's runtime is running now. */
  protected async containerRunning(backing: HostedBacking): Promise<boolean> {
    if (backing.kind === "platform-container")
      return this.state.container?.running === true;
    return await this.onBoxVmHost(backing.hostId).running();
  }

  #containerBackend(backing: HostedBacking): SystemTrustContainerBackend {
    return new SystemTrustContainerBackend({
      id: attachedBackendId(backing),
      container: () => ({
        getWorkspaceContainer: () => this.hostedContainerHost(backing),
      }),
      workspace: {
        binding: computerBinding,
        id: this.state.id.toString(),
      },
      egress: this.bindings.COMPUTER_EGRESS
        ? {
            mode: "http-gateway",
            gateway: this.bindings.COMPUTER_EGRESS({
              props: { computerObjectId: this.state.id.toString() },
            }),
          }
        : { mode: "none" },
      // The library heartbeat competes with a busy container command and
      // previously closed healthy long-running executions.
      heartbeatIntervalMs: 0,
    });
  }

  /** A consuming host supplies its admitted shell loopback context. */
  protected workerShellContext(): Pick<DurableObjectState, "exports"> {
    return this.state;
  }

  /** The Workspace for the current attached set, rebuilt when it changes. */
  protected workspace(): Workspace {
    const attached = this.attachedBackends();
    const key = JSON.stringify(attached);
    if (this.#generation?.key === key) return this.#generation.workspace;
    const previous = this.#generation;
    const containers = new Map<string, SystemTrustContainerBackend>();
    const backends: WorkspaceRegisteredBackend[] = [];
    if (this.bindings.LOADER)
      backends.push(
        new WorkerShellBackend({
          loader: this.bindings.LOADER,
          workspace: {
            binding: computerBinding,
            id: this.state.id.toString(),
          },
          ctx: this.workerShellContext(),
          commands: [jqCommands, yqCommands, xanCommands, fileCommands],
          egress: { mode: "none" },
        }),
      );
    for (const backend of attached) {
      if (backend.kind === "local") {
        backends.push(
          computerTransportBackend(
            new LocalWorkspaceBackend(backend, this.localConnections),
          ),
        );
        continue;
      }
      const container = this.#containerBackend(backend);
      containers.set(container.id, container);
      backends.push(computerTransportBackend(container));
    }
    this.#generation = {
      key,
      containers,
      workspace: new Workspace({
        storage: {
          sql: {
            exec: <Row extends object>(query: string, ...bindings: unknown[]) =>
              this.state.storage.sql.exec<
                Row & Record<string, SqlStorageValue>
              >(query, ...bindings),
          },
          transactionSync: (body) => this.state.storage.transactionSync(body),
        },
        backends,
        retryScheduler: this.#pullPending.scheduler,
      }),
    };
    this.localConnections.retain(
      new Set(
        attached
          .filter((backend) => backend.kind === "local")
          .map(attachedBackendId),
      ),
    );
    if (previous !== undefined)
      this.state.waitUntil(
        previous.workspace.close().catch((cause: unknown) => {
          console.error("Computer runtime operation failed", cause);
          return undefined;
        }),
      );
    return this.#generation.workspace;
  }

  /**
   * The current Workspace once its mount index is ready and its guest mount
   * root exists. Every backend mounts `/workspace`, so a host write there
   * (such as a Workflow step's one-shot Git credential file) must not depend
   * on a guest having booted first.
   */
  protected async readyWorkspace(): Promise<Workspace> {
    const workspace = this.workspace();
    await workspace.ready();
    if (!this.#rootedWorkspaces.has(workspace)) {
      await workspace.fs.mkdir(workspaceMountRoot, { recursive: true });
      this.#rootedWorkspaces.add(workspace);
    }
    return workspace;
  }

  /** `getWorkspace(stub)` reaches the current generation through this door. */
  async __getWorkspaceStub() {
    return (await this.readyWorkspace()).stub();
  }

  /**
   * Backend doors. An attached machine dials in on its public connect path.
   * A container backend's `/ws` upgrade and egress: the platform container's
   * arrive as `/ws` through WorkspaceProxy; an on-box VM's through the
   * verified ingress door as `/__vm/<hostId>/ws`.
   */
  public override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const dial = localBackendDialPath.exec(url.pathname);
    if (dial !== null)
      return this.#acceptLocalDial(request, dial[2] ?? "", dial[3] ?? "");
    const vm = vmUpgradePath.exec(url.pathname);
    const id = vm === null ? "container" : `vm-${vm[1] ?? ""}`;
    if (vm !== null) url.pathname = vm[2] ?? "/ws";
    const container = this.#generation?.containers.get(id);
    if (container === undefined)
      return Promise.resolve(new Response("not found", { status: 404 }));
    return container.handleFetch(new Request(url, request));
  }
}

/** One upstream Cloudflare Workspace that advertises and runs its capabilities. */
export class ComputerDO extends ContainerComputer {
  #binaryFileTail: Promise<undefined> = Promise.resolve(undefined);
  #operationRecord: ComputerOperationRecord | undefined;
  #processRecord: ComputerProcessInventory | undefined;
  #terminalSync: Promise<void> | undefined;

  get #processes(): ComputerProcessInventory {
    this.#processRecord ??= new ComputerProcessInventory(
      this.state.storage,
      () => Date.now(),
    );
    return this.#processRecord;
  }

  get #operations(): ComputerOperationRecord {
    this.#operationRecord ??= new ComputerOperationRecord(
      this.state.storage,
      () => Date.now(),
    );
    return this.#operationRecord;
  }

  #ensureExposedPorts(): void {
    void this.#processes;
  }

  #readExposedPorts(): number[] {
    this.#ensureExposedPorts();
    const rows = this.state.storage.sql
      .exec<{ port: number }>(
        "SELECT port FROM computer_exposed_ports ORDER BY port",
      )
      .toArray();
    // Rows admitted before a port became reserved stay removable but are
    // never presented as previewable.
    return computerPortsOutputSchema.parse({
      ports: rows
        .map(({ port }) => port)
        .filter((port) => !isComputerReservedPort(port)),
    }).ports;
  }

  /** Persist the bounded set of ports admitted for preview on this Computer. */
  exposePort(input: {
    port: number;
  }): Promise<{ port: number; exposed: boolean }> {
    return this.exposePortAfterAcceptance(input, () => undefined);
  }

  /** Host checks current authority at the write boundary. */
  protected exposePortAfterAcceptance(
    input: { port: number },
    accept: () => void,
  ): Promise<{ port: number; exposed: boolean }> {
    const { port } = computerPortInputSchema.parse(input);
    if (isComputerReservedPort(port)) throw new ComputerPortReservedError(port);
    this.#ensureExposedPorts();
    const exposed = this.state.storage.transactionSync(() => {
      accept();
      const existing =
        this.state.storage.sql
          .exec<{ port: number }>(
            "SELECT port FROM computer_exposed_ports WHERE port = ?",
            port,
          )
          .toArray().length > 0;
      if (!existing) {
        const count = this.state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM computer_exposed_ports",
          )
          .toArray()[0]?.count;
        if (count === undefined || count >= maximumExposedPorts) {
          throw new ComputerPortLimitError();
        }
      }
      this.state.storage.sql.exec(
        "INSERT INTO computer_exposed_ports (port, process_id) VALUES (?, NULL) ON CONFLICT(port) DO UPDATE SET process_id = NULL",
        port,
      );
      return true;
    });
    return Promise.resolve(computerPortOutputSchema.parse({ port, exposed }));
  }

  /** List only the durable port-admission metadata for this Computer. */
  listPorts(): Promise<{ ports: number[] }> {
    return this.listPortsAfterAcceptance(() => undefined);
  }

  /** Host checks current authority before returning the admitted port set. */
  protected listPortsAfterAcceptance(
    accept: () => void,
  ): Promise<{ ports: number[] }> {
    this.#ensureExposedPorts();
    accept();
    return Promise.resolve(
      computerPortsOutputSchema.parse({
        ports: this.#readExposedPorts(),
      }),
    );
  }

  /** Remove one port from the Computer's durable preview admission set. */
  unexposePort(input: {
    port: number;
  }): Promise<{ port: number; removed: boolean }> {
    return this.unexposePortAfterAcceptance(input, () => undefined);
  }

  /** Host checks current authority at the write boundary. */
  protected unexposePortAfterAcceptance(
    input: { port: number },
    accept: () => void,
  ): Promise<{ port: number; removed: boolean }> {
    const { port } = computerPortInputSchema.parse(input);
    this.#ensureExposedPorts();
    const exposed = this.state.storage.transactionSync(() => {
      accept();
      const rows = this.state.storage.sql.exec(
        "DELETE FROM computer_exposed_ports WHERE port = ? RETURNING port",
        port,
      );
      return rows.toArray().length > 0;
    });
    return Promise.resolve(
      computerPortRemovalOutputSchema.parse({ port, removed: exposed }),
    );
  }

  /**
   * Proxy one admitted request to this Computer's container. The host must
   * pass a Request whose URL is service-relative, using the `http://localhost`
   * placeholder origin and a path/query with the Hub route prefix removed.
   */
  protected async portPreviewAfterAcceptance(
    portInput: number,
    request: Request,
    accept: () => void,
  ): Promise<Response> {
    const port = computerPortSchema.parse(portInput);
    if (isComputerReservedPort(port)) {
      return Response.json({ error: "port is reserved" }, { status: 400 });
    }
    const incoming = new URL(request.url);
    if (incoming.origin !== "http://localhost") {
      return Response.json(
        { error: "preview request must use a service-relative URL" },
        { status: 400 },
      );
    }
    const target = new URL("http://localhost");
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    this.#ensureExposedPorts();
    const exposed = this.state.storage.transactionSync(() => {
      const found =
        this.state.storage.sql
          .exec<{ port: number }>(
            "SELECT port FROM computer_exposed_ports WHERE port = ?",
            port,
          )
          .toArray().length > 0;
      if (found) accept();
      return found;
    });
    if (!exposed)
      return Response.json({ error: "port is not exposed" }, { status: 404 });
    if (request.headers.has("upgrade"))
      return Response.json(
        { error: "preview WebSocket upgrades are not supported" },
        { status: 400 },
      );

    try {
      const headers = new Headers(request.headers);
      for (const name of [
        "authorization",
        "cookie",
        "proxy-authorization",
        "cf-access-jwt-assertion",
        "cf-access-client-id",
        "cf-access-client-secret",
        "cf-access-authenticated-user-email",
        "x-authenticated-user",
        "x-authenticated-email",
        "x-auth-request-user",
        "x-auth-request-email",
        "x-user-id",
        "x-user-email",
        "x-forwarded-user",
        "x-forwarded-email",
      ])
        headers.delete(name);
      const forwarded = new Request(target, request);
      const hosted = this.hostedRoute();
      if (hosted === undefined)
        throw new ComputerBackendUnavailableError("no_backend");
      const response = await this.withHostedResponse(hosted.backing, () =>
        this.hostedContainerHost(hosted.backing)
          .port(port)
          .fetch(new Request(forwarded, { headers })),
      );
      const safeHeaders = new Headers(response.headers);
      safeHeaders.delete("set-cookie");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: safeHeaders,
      });
    } catch (cause) {
      console.error("Computer runtime operation failed", cause);

      return Response.json(
        { error: "Computer port service is unavailable" },
        { status: 502 },
      );
    }
  }

  async #withBinaryFile<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#binaryFileTail;
    const next = Promise.withResolvers<undefined>();
    this.#binaryFileTail = next.promise;
    await previous;
    try {
      return await operation();
    } finally {
      next.resolve(undefined);
    }
  }

  /**
   * Move changes between the Workspace and a hosted runtime that is already
   * running, through the library's own sync cursors. It never boots one: a
   * stopped runtime catches up in its next command or terminal bracket. A
   * failure leaves the cursor in place for the next sync and is logged, not
   * thrown, because the Workspace operation itself has committed.
   */
  async #syncRunningHosted(direction: "push" | "pull"): Promise<void> {
    const hosted = this.hostedRoute();
    if (hosted === undefined) return;
    try {
      if (!(await this.containerRunning(hosted.backing))) return;
    } catch (cause) {
      if (cause instanceof ComputerContainersPausedError) return;
      throw cause;
    }
    try {
      const workspace = await this.readyWorkspace();
      if (direction === "push") await workspace.push(hosted.id);
      else await workspace.pull(hosted.id);
    } catch (cause) {
      console.error(`Computer Workspace ${direction} failed`, cause);
    }
  }

  /** One loop per Computer while any terminal socket is attached. */
  #startTerminalSync(backing: HostedBacking): void {
    if (this.#terminalSync !== undefined) return;
    this.#terminalSync = this.#terminalSyncLoop(backing).finally(() => {
      this.#terminalSync = undefined;
    });
    this.state.waitUntil(this.#terminalSync);
  }

  async #terminalSyncLoop(backing: HostedBacking): Promise<void> {
    for (;;) {
      await new Promise((resolve) =>
        setTimeout(resolve, terminalSyncIntervalMs),
      );
      try {
        if (!(await this.containerRunning(backing))) return;
        const response = await this.hostedContainerHost(backing)
          .port(computerTerminalPort)
          .fetch(new Request("http://localhost/sessions"));
        if (!response.ok) return;
        const { attached } = terminalSessionsSchema.parse(
          await response.json(),
        );
        if (attached === 0) return;
      } catch (cause) {
        console.error("Computer terminal sync probe failed", cause);
        return;
      }
      await this.#syncRunningHosted("push");
      await this.#syncRunningHosted("pull");
    }
  }

  getCapabilities() {
    return Promise.resolve(computerCapabilities());
  }

  /** Read bounded native bytes before releasing the single-owner Workspace. */
  async readFile(
    input: ComputerFileReadInput,
  ): Promise<ReadableStream<Uint8Array>> {
    return (await this.readFileAfterAcceptance(input, () => undefined)).body;
  }

  /** Resource hosts may accept authority after the file queue and Workspace are ready. */
  protected async readFileAfterAcceptance(
    input: ComputerFileByteReadInput,
    accept: () => void,
    maximumBytes = maximumFileBytes,
  ) {
    const {
      path,
      byteOffset = 0,
      byteLength,
    } = readBytesInputSchema.parse(input);
    return await this.#withBinaryFile(async () => {
      const workspace = await this.readyWorkspace();
      accept();
      await this.#syncRunningHosted("pull");
      const stat = await workspace.fs.stat(path);
      if (!stat.isFile) throw new Error("Computer path is not a file");
      if (byteOffset > stat.size) throw new ComputerFileRangeError(stat.size);
      const size = Math.min(byteLength ?? stat.size, stat.size - byteOffset);
      if (size > maximumBytes) throw new ComputerFileTooLargeError();
      accept();
      const source = await workspace.fs.readFile(path, {
        byteOffset,
        byteLength: size,
      });
      const reader = source.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      let done = false;
      try {
        while (!done) {
          const next = await reader.read();
          done = next.done;
          if (next.done) continue;
          length += next.value.byteLength;
          if (length > maximumBytes) {
            await reader.cancel("File exceeds the Computer read bound");
            throw new ComputerFileTooLargeError();
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (length !== size) throw new Error("File changed during byte read");
      return {
        offset: byteOffset,
        total: stat.size,
        length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    });
  }

  /** Completion means the maintained Workspace writer consumed and committed the stream. */
  async writeFile(
    input: ComputerFileReadInput,
    content: ReadableStream<Uint8Array>,
  ): Promise<void> {
    await this.writeFileAfterAcceptance(input, content, () => undefined);
  }

  /** Resource hosts may accept authority after the file queue and Workspace are ready. */
  protected async writeFileAfterAcceptance(
    input: ComputerFileReadInput,
    content: ReadableStream<Uint8Array>,
    accept: () => void,
  ): Promise<void> {
    const { path } = readInputSchema.parse(input);
    await this.#withBinaryFile(async () => {
      const workspace = await this.readyWorkspace();
      accept();
      await workspace.fs.writeFile(path, content);
    });
    await this.#syncRunningHosted("push");
  }

  /** Keep one Workspace lease around one authorized structured Files operation. */
  protected async withFilesAfterAcceptance<A>(
    accept: () => void,
    operation: (
      files: ReturnType<typeof createWorkspaceFilesPort>,
    ) => Promise<A>,
  ): Promise<A> {
    const workspace = await this.readyWorkspace();
    accept();
    await this.#syncRunningHosted("pull");
    return await operation(createWorkspaceFilesPort(workspace, this));
  }

  /** A Files write uses the packaged native engine and the ordinary metered backend. */
  protected async applyPatchAfterAcceptance(
    input: { patch: string },
    accept: () => void,
  ) {
    const route = this.routeBackend(undefined, "hosted");
    return await this.runOnBackend(route, async () => {
      const workspace = await this.readyWorkspace();
      accept();
      return await applyWorkspacePatch(workspace, route.id, input);
    });
  }

  /** Write bounded UTF-8 text after the resource host accepts local authority. */
  protected async writeTextAfterAcceptance(
    input: z.output<typeof writeInputSchema>,
    accept: () => void,
  ): Promise<z.output<typeof writeOutputSchema>> {
    const workspace = await this.readyWorkspace();
    accept();
    const result = await write(workspace, input);
    await this.#syncRunningHosted("push");
    return result;
  }

  async call(
    capabilityId: ComputerValue,
    input: ComputerValue,
  ): Promise<ComputerValue> {
    if (capabilityNameSchema.parse(capabilityId) === "start_process") {
      const toolInput = processStartToolInputSchema.parse(input);
      return await this.startProcessAfterAcceptance(
        computerValueSchema.parse({
          ...toolInput,
          requestId: mintComputerRequestId(),
          requestScope: "native-tool",
        }),
        () => undefined,
      );
    }
    return await this.callAfterAcceptance(capabilityId, input, () => undefined);
  }

  /** Resource hosts may accept authority once the Workspace is ready to dispatch. */
  protected async callAfterAcceptance(
    capabilityId: ComputerValue,
    input: ComputerValue,
    accept: () => void,
  ): Promise<ComputerValue> {
    const selected = capabilityNameSchema.parse(capabilityId);
    if (selected === "bash" || selected === "exec") {
      accept();
      // The native call is one tool invocation with no host retry: mint here.
      return computerToolResult(
        await this.executeOperationAfterAcceptance(
          {
            ...execInputSchema.parse(input),
            requestId: mintComputerRequestId(),
          },
          () => undefined,
          selected,
        ),
      );
    }
    switch (selected) {
      case "start_process":
        return await this.startProcessAfterAcceptance(input, accept);
      case "list_processes":
        return await this.listProcessesAfterAcceptance(accept);
      case "kill_process":
        return await this.killProcessAfterAcceptance(input, accept);
    }
    const workspace = await this.readyWorkspace();
    accept();
    switch (selected) {
      case "read":
        await this.#syncRunningHosted("pull");
        return await read(workspace, input);
      case "list":
        await this.#syncRunningHosted("pull");
        return await list(workspace, input);
      case "mkdir": {
        const result = await mkdir(workspace, input);
        await this.#syncRunningHosted("push");
        return result;
      }
      case "write": {
        const result = await write(workspace, input);
        await this.#syncRunningHosted("push");
        return result;
      }
      default:
        throw new Error(`Computer capability is unavailable: ${selected}`);
    }
  }

  /**
   * Execute a host request once, after the host accepts current authority.
   * `exec` runs on the Workspace's built-in Worker shell unless it names an
   * attached backend; `bash` always runs on an attached backend, the named one
   * or the first available in the default order.
   */
  protected async executeOperationAfterAcceptance(
    input: ComputerExecRequest,
    accept: () => void,
    kind: "exec" | "bash",
    budget: ComputerExecutionBudget = genericComputerExecutionBudget,
    signal?: AbortSignal,
  ): Promise<ComputerOperationResult> {
    const { requestId, ...command } =
      computerExecutionRequestSchema(budget).parse(input);
    const route =
      kind === "exec" && command.backend === undefined
        ? undefined
        : this.routeBackend(command.backend, "exec");
    const run = async () => {
      const workspace = await this.readyWorkspace();
      const inputHash = await sha256(
        JSON.stringify({
          kind,
          command: command.command,
          cwd: command.cwd ?? null,
          timeoutMs: command.timeoutMs,
          backend: command.backend ?? null,
        }),
      );
      const operations: ComputerOperationRecord = this.#operations;
      signal?.throwIfAborted();
      const recorded = operations.admit(requestId, inputHash, accept);
      if (recorded !== undefined) return recorded;
      operations.markRunning(requestId);
      try {
        operations.settle(
          requestId,
          await exec(workspace, command, route?.id, signal),
        );
      } catch (cause) {
        operations.settleUnknown(
          requestId,
          cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : "Computer execution rejected without an Error",
        );
      }
      return operations.status(requestId, () => undefined);
    };
    return route === undefined
      ? await run()
      : await this.runOnBackend(route, run);
  }

  /**
   * Run one command on a routed backend. Owners admit and meter hosted
   * backends here; a member's own machine is neither reserved nor metered.
   */
  protected async runOnBackend<T>(
    route: Extract<BackendRoute, { kind: "routed" }>,
    run: () => Promise<T>,
  ): Promise<T> {
    void route;
    return await run();
  }

  /** Start one long-running container process with a durable identity. */
  async startProcess(input: ComputerValue): Promise<ComputerProcess> {
    return await this.startProcessAfterAcceptance(input, () => undefined);
  }

  /** The host accepts authority when the running slot is reserved. */
  protected async startProcessAfterAcceptance(
    input: ComputerValue,
    accept: () => void,
  ): Promise<ComputerProcess> {
    const start = processStartInputSchema.parse(input);
    const { command, cwd } = start;
    const inputHash = await sha256(
      JSON.stringify({ command, cwd: cwd ?? null, port: start.port ?? null }),
    );
    const replay = this.#processes.replay(start, inputHash, accept);
    if (replay !== undefined) return replay;
    if (start.port !== undefined && isComputerReservedPort(start.port))
      throw new ComputerPortReservedError(start.port);
    const backend = this.requireHostedRoute().id;
    const workspace = await this.readyWorkspace();
    const admission = this.#processes.admit(start, inputHash, accept);
    if (!admission.created) return admission.process;
    const admitted = admission.process;
    const id = admitted.id;
    let run: WorkspaceRuntimeExecHandle<"utf8">;
    try {
      // timeoutMs 0 disables computerd's default 320 s command deadline.
      const options: WorkspaceRuntimeExecOptions<"utf8"> = {
        id,
        backend,
        encoding: "utf8",
        timeoutMs: 0,
      };
      if (cwd !== undefined) options.cwd = cwd;
      run = await workspace.runtime.exec(command, options);
    } catch (error) {
      // A transport failure after dispatch may still have started it.
      const observed = await observeProcess(
        processRuntime(workspace, backend),
        id,
      );
      if (observed.state === "exited" && observed.exitCode === null) {
        this.#processes.release(id);
        throw error;
      }
      return this.#settle(id, observed);
    }
    this.state.waitUntil(this.#watchProcess(id, run));
    return admitted;
  }

  /** List this Computer's processes, reconciling live ones with computerd. */
  async listProcesses(): Promise<{ processes: ComputerProcess[] }> {
    return await this.listProcessesAfterAcceptance(() => undefined);
  }

  protected async listProcessesAfterAcceptance(
    accept: () => void,
  ): Promise<{ processes: ComputerProcess[] }> {
    accept();
    const rows = this.#processes.list();
    const running = rows.filter((row) => row.state === "running");
    if (running.length === 0)
      return processListOutputSchema.parse({
        processes: rows.slice(0, maximumProcessRecords),
      });
    const hosted = this.hostedRoute();
    if (
      hosted === undefined ||
      !(await this.containerRunning(hosted.backing))
    ) {
      // No container means none of its processes survived; do not wake it.
      for (const row of running) this.#processes.exited(row.id, null);
      return processListOutputSchema.parse({
        processes: this.#processes.list().slice(0, maximumProcessRecords),
      });
    }
    const workspace = await this.readyWorkspace();
    const runtime = processRuntime(workspace, hosted.id);
    const observed = new Map(
      await Promise.all(
        running.map(
          async (row) =>
            [
              row.id,
              this.#settle(row.id, await observeProcess(runtime, row.id)),
            ] as const,
        ),
      ),
    );
    return processListOutputSchema.parse({
      processes: rows
        .slice(0, maximumProcessRecords)
        .map((row) => observed.get(row.id) ?? row),
    });
  }

  /** Send SIGTERM to one running process; its exit is recorded when observed. */
  async killProcess(
    input: ComputerValue,
  ): Promise<{ process: ComputerProcess; signalled: boolean }> {
    return await this.killProcessAfterAcceptance(input, () => undefined);
  }

  protected async killProcessAfterAcceptance(
    input: ComputerValue,
    accept: () => void,
  ): Promise<{ process: ComputerProcess; signalled: boolean }> {
    const { id } = processIdInputSchema.parse(input);
    accept();
    const row = this.#processes.get(id);
    if (row === undefined) throw new ComputerProcessNotFoundError(id);
    if (row.state !== "running")
      return processKillOutputSchema.parse({ process: row, signalled: false });
    const hosted = this.hostedRoute();
    if (hosted === undefined || !(await this.containerRunning(hosted.backing)))
      return processKillOutputSchema.parse({
        process: this.#processes.exited(id, null),
        signalled: false,
      });
    const workspace = await this.readyWorkspace();
    try {
      await workspace.runtime.killExec(id, {
        backend: hosted.id,
        signal: "SIGTERM",
      });
    } catch (cause) {
      console.error("Computer runtime operation failed", cause);

      const observed = await observeProcess(
        processRuntime(workspace, hosted.id),
        id,
      );
      return processKillOutputSchema.parse({
        process: this.#settle(id, observed),
        signalled: false,
      });
    }
    return processKillOutputSchema.parse({ process: row, signalled: true });
  }

  /**
   * A "pending" verdict's background continuation keeps the host alive
   * until it resolves (a stuck transport cannot keep this running past
   * that drain's own completion, success or not) and then upgrades the
   * row: pending rows must be updatable, not only running ones.
   */
  #watchResync(
    id: ComputerProcessId,
    settleLater: Promise<ComputerProcessSync>,
  ): void {
    this.state.waitUntil(
      settleLater.then((sync) => {
        this.#processes.resync(id, sync);
      }),
    );
  }

  /** Persist a proven exit; report an unreachable check without storing it. */
  #settle(
    id: ComputerProcessId,
    observed: ProcessObservation,
  ): ComputerProcess {
    if (observed.state === "exited") {
      if (observed.settleLater !== undefined)
        this.#watchResync(id, observed.settleLater);
      return this.#processes.exited(id, observed.exitCode, observed.sync);
    }
    const row = this.#processes.get(id);
    if (row === undefined) throw new ComputerProcessNotFoundError(id);
    return observed.state === "uncertain"
      ? { ...row, state: "uncertain" }
      : row;
  }

  /**
   * Record a started process's exit once `drainProcessExit` observes it:
   * that function is the tested implementation (it also backs
   * `process-inventory-proof.mjs`'s direct coverage of this drain), so
   * this method is a thin, DO-specific wrapper around it.
   */
  async #watchProcess(
    id: ComputerProcessId,
    run: WorkspaceRuntimeExecHandle<"utf8">,
  ): Promise<void> {
    try {
      const settled = await drainProcessExit(run);
      if (settled !== undefined) {
        if (settled.settleLater !== undefined)
          this.#watchResync(id, settled.settleLater);
        this.#processes.exited(id, settled.exitCode, settled.sync);
      }
    } catch (cause) {
      console.error("Computer runtime operation failed", cause);

      // The stream broke (eviction, transport); list reconciles later.
    }
  }

  protected getOperationStatusAfterAcceptance(
    requestId: string,
    accept: () => void,
  ): ComputerOperationResult {
    return this.#operations.status(requestId, accept);
  }

  /**
   * Relay one authorized terminal upgrade to this Computer's own terminal
   * server, which keeps the PTY for `session` across socket reconnects.
   */
  protected async terminalAfterAcceptance(
    request: Request,
    principalKey: string,
    accept: () => void,
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const incoming = new URL(request.url);
    const query = terminalQuerySchema.safeParse({
      session: incoming.searchParams.get("session") ?? undefined,
      cols: incoming.searchParams.get("cols"),
      rows: incoming.searchParams.get("rows"),
    });
    if (!query.success) {
      return Response.json(
        { error: "invalid terminal options" },
        { status: 400 },
      );
    }

    const hosted = this.hostedRoute();
    if (hosted === undefined)
      return Response.json(
        { error: "Computer container is unavailable" },
        { status: 502 },
      );
    try {
      const workspace = await this.readyWorkspace();
      using readiness = await workspace.runtime.exec("true", {
        backend: hosted.id,
        encoding: "utf8",
        timeoutMs: 10_000,
      });
      const result = await readiness.result();
      if (result.status !== "completed" || result.exitCode !== 0) {
        return Response.json(
          { error: "Computer container is unavailable" },
          { status: 502 },
        );
      }
    } catch (cause) {
      console.error("Computer runtime operation failed", cause);

      return Response.json(
        { error: "Computer container is unavailable" },
        { status: 502 },
      );
    }

    // Hub rechecks current Computer/operation authority at the dispatch seam.
    accept();

    try {
      const target = new URL("http://localhost/pty");
      target.search = new URLSearchParams({
        ...(await this.terminalDisplayEnvironment()),
        session: await sha256(
          JSON.stringify([principalKey, query.data.session]),
        ),
        cols: String(query.data.cols),
        rows: String(query.data.rows),
      }).toString();
      const response = await this.withHostedResponse(hosted.backing, () =>
        this.hostedContainerHost(hosted.backing)
          .port(computerTerminalPort)
          .fetch(new Request(target, request)),
      );
      if (response.status === 101) this.#startTerminalSync(hosted.backing);
      return response;
    } catch (cause) {
      console.error("Computer runtime operation failed", cause);

      return Response.json(
        { error: "Failed to reach the Computer terminal service" },
        { status: 502 },
      );
    }
  }

  protected withHostedResponse(
    _backing: HostedBacking,
    run: () => Promise<Response>,
  ): Promise<Response> {
    return run();
  }

  /** Host-owned display labels only; never credentials or provider URLs. */
  protected terminalDisplayEnvironment(): Promise<Record<string, string>> {
    return Promise.resolve({
      FUNGI_COMPUTER_NAME: this.state.id.name ?? "Computer",
    });
  }

  /** Atomically replace one bounded file only when its raw contents still match. */
  async replaceFileIfUnchanged(
    input: ComputerFileReplacement,
  ): Promise<ComputerFileReplacementResult> {
    return await this.replaceFileIfUnchangedAfterAcceptance(
      input,
      () => undefined,
    );
  }

  /** Stale-safe replacement with authority checked at the transaction boundary. */
  protected async replaceFileIfUnchangedAfterAcceptance(
    input: ComputerFileReplacement,
    accept: () => void,
  ): Promise<ComputerFileReplacementResult> {
    const replacement = replaceInputSchema.parse(input);
    const workspace = await this.readyWorkspace();
    await this.#syncRunningHosted("pull");
    const provider = new SQLiteWorkspaceProvider(workspace.fs.db);
    const result = writeOutputSchema.parse(
      this.state.storage.transactionSync(() => {
        accept();
        const current = readBoundedWorkspaceText(
          provider,
          replacement.path,
          maximumFileBytes,
        );
        if (current !== replacement.expectedContent) {
          throw new ComputerFileConflict();
        }
        provider.writeFileSync(replacement.path, replacement.content);
        return {
          path: replacement.path,
          bytes: utf8.encode(replacement.content).byteLength,
        };
      }),
    );
    await this.#syncRunningHosted("push");
    return result;
  }
}

// Runtime backends reach the authoritative Workspace through these loopback
// entrypoints. The consuming Worker must re-export both from its main module.
export { WorkspaceProxy, WorkspaceServiceProxy };
export {
  OnBoxVmContainerHost,
  onBoxVmPlacement,
  onBoxVmIngress,
  type OnBoxVmEnv,
  type OnBoxVmState,
} from "./on-box-vm.js";
export { computerContainerSleepAfterMs } from "./container-policy.js";
export * from "./computer-backends.js";
export {
  LocalBackendOfflineError,
  localBackendAudience,
  localBackendDialPath,
  verifyLocalBackendDial,
} from "./local-backend.js";
/** Keep each native Workspace lease inside the operation that uses it. */
export function createComputerFilesPort(computer: ComputerRpc): FilesPort {
  async function withFiles<A>(
    operation: (
      files: ReturnType<typeof createWorkspaceFilesPort>,
    ) => Promise<A>,
  ) {
    using workspace = await getWorkspace(computer);
    return await operation(createWorkspaceFilesPort(workspace, computer));
  }
  return {
    read: (input) => withFiles((files) => files.read(input)),
    list: (input) => withFiles((files) => files.list(input)),
    glob: (input) => withFiles((files) => files.glob(input)),
    grep: (input) => withFiles((files) => files.grep(input)),
    replace: async (input, context) => {
      context.signal.throwIfAborted();
      return await computer.replaceFileIfUnchanged(input);
    },
  };
}

export { createWorkspaceFilesPort, type WorkspaceFilesOwner } from "./files.js";
export * from "./operation-contract.js";
export {
  ComputerOperationConflictError,
  ComputerOperationLimitError,
  ComputerRequestInvalidError,
} from "./operation-record.js";

export type { ContainerComputer };
