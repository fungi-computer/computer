import { z } from "zod";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  execRequestSchema,
  computerProcessIdSchema,
  processStartInputSchema,
  isComputerReservedPort,
  type ComputerExecutionHostHooks,
  type ComputerExecutionHostPort,
  type ComputerExecutionCloseReason,
  type ComputerProcess,
  type ComputerOperationResult,
} from "@fungi.computer/computer-contract";

import {
  getWorkspace,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeExecHandle,
  type WorkspaceRuntimeExecOptions,
  type WorkspaceRuntimeGetOptions,
  type WorkspaceObserver,
  type Workspace,
} from "@fungi.computer/cloudflare-computer";
import {
  ComputerDO as NativeComputerDO,
  ComputerOperationConflictError,
  ComputerRequestInvalidError,
  createComputerFilesPort,
  createWorkspaceFilesPort,
  onBoxVmIngress,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type ComputerNamespace,
  type ComputerRpc,
  type OnBoxVmEnv,
} from "../src/index.js";
import {
  failedObservation,
  type ProcessRuntime,
} from "../src/process-inventory.js";

export { WorkspaceProxy, WorkspaceServiceProxy };

export type AssertTrue<Value extends true> = Value;
export type IsAssignable<Source, Target> = [Source] extends [Target]
  ? true
  : false;
export type ProcessEventStream = Awaited<ReturnType<ProcessRuntime["getExec"]>>;
export type MaintainedEventStream = ReadableStream<
  WorkspaceRuntimeEvent<"utf8">
> &
  Disposable;
export type ArbitraryEventStream = ReadableStream<
  Readonly<{ name: string; code?: number }>
> &
  Disposable;

/** Compile-time proof for the process owner's maintained event contract. */
export type ProcessRuntimeEventContractProof = readonly [
  AssertTrue<
    IsAssignable<WorkspaceRuntimeExecHandle<"utf8">, ProcessEventStream>
  >,
  AssertTrue<IsAssignable<MaintainedEventStream, ProcessEventStream>>,
  AssertTrue<
    IsAssignable<ArbitraryEventStream, ProcessEventStream> extends false
      ? true
      : false
  >,
];

/** Test-only route into the protected host seam; production exposes no PTY URL. */
export class ComputerDO extends NativeComputerDO {
  readonly #carriagePresenters = new Map<string, string>();
  #carriageOpens = 0;
  #carriageRenewals = 0;
  #carriageCloses = 0;
  readonly #tracedWorkspaces = new WeakSet<Workspace>();
  #nativeDispatches = 0;
  #nativeProbes = 0;
  #workspaceReads = 0;
  readonly #renewProofs: boolean[] = [];
  #openGate: ReturnType<typeof Promise.withResolvers<undefined>> | undefined;
  #sdkGate: ReturnType<typeof Promise.withResolvers<undefined>> | undefined;
  #rawNativeAvailable = false;
  #pendingProcess: Promise<void> | undefined;
  #pendingExec: Promise<void> | undefined;
  #pendingKill: Promise<void> | undefined;
  #killSettled = false;
  #killRejected = false;
  #killSignalled: boolean | null = null;
  #execSettled = false;
  #execSucceeded: boolean | null = null;
  #execStatus: ComputerOperationResult["status"] | undefined;
  #binaryStdin = false;
  #process: ComputerProcess | undefined;
  #retentionAnchor: ComputerProcess | undefined;
  #watchedProcessId: ComputerProcess["id"] | undefined;
  #watchedScope = "execution-law";
  #startSettled = false;
  #invocationId: string | undefined;
  #live: boolean | null = null;
  #refuseOpen = false;
  #startRejected = false;
  readonly #closeReasons: ComputerExecutionCloseReason[] = [];
  readonly #closedBeforeCallbacks: (boolean | null)[] = [];
  readonly #nativeExitEvents = new Set<string>();
  readonly #nativeExitCodes = new Map<string, number>();
  readonly #observedNativeBackends = new Map<string, string>();
  readonly #nativeReadyPrefixes = new Map<string, string>();
  #ignoreTerm = false;
  #loseDispatchReply = false;
  #watcherDeliveryGate:
    ReturnType<typeof Promise.withResolvers<undefined>> | undefined;
  #pullCalls = 0;
  #pullsAtDispatch = 0;
  #probing = false;
  #probeAttempt = 0;
  #probeTrace: string[] = [];
  #watcherOutputHeld = false;
  #exitWitnessBusy = 0;
  readonly #nativeExitBeforeCallbacks: (boolean | null)[] = [];
  readonly #selectedBackends = new Map<string, string>();
  readonly #nativeBackends = new Map<string, string>();

  #durablyClosed(
    id: string,
    reason: ComputerExecutionCloseReason,
  ): boolean | null {
    // Read the named application owner directly; a missing row is unknown.
    const row = this.state.storage.sql
      .exec(
        "SELECT phase, close_reason, backend, native_opened FROM computer_execution_invocations WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const closed = z
      .strictObject({
        phase: z.string(),
        close_reason: z.string().nullable(),
        backend: z.string().min(1),
        native_opened: z.union([z.literal(0), z.literal(1)]),
      })
      .parse(row);
    return (
      closed.phase === "closed" &&
      closed.close_reason === reason &&
      (this.#selectedBackends.get(id) === undefined ||
        closed.backend === this.#selectedBackends.get(id)) &&
      (reason !== "native_exit" ||
        (closed.native_opened === 1 &&
          closed.backend ===
            (this.#nativeBackends.get(id) ??
              this.#observedNativeBackends.get(id))))
    );
  }

  /** Count real SDK calls; every call still delegates to the maintained runtime. */
  protected override workspace(): Workspace {
    const workspace = super.workspace();
    this.#workspaceReads++;
    if (this.#tracedWorkspaces.has(workspace)) return workspace;
    this.#tracedWorkspaces.add(workspace);
    const span = workspace.observer.span.bind(workspace.observer);
    const observeSpan: WorkspaceObserver["span"] = (name, attributes, run) => {
      if (name === "workspace.sync.pull") this.#pullCalls++;
      return span(name, attributes, run);
    };
    workspace.observer.span = observeSpan;
    const runtime = workspace.runtime;
    const exec = runtime.exec.bind(runtime);
    const getExec = runtime.getExec.bind(runtime);
    const dispatched = () => {
      this.#nativeDispatches++;
      this.#pullsAtDispatch = this.#pullCalls;
    };
    const probed = () => this.#nativeProbes++;
    const nativeExited = (id: string, code: number) => {
      this.#nativeExitEvents.add(id);
      this.#nativeExitCodes.set(id, code);
    };
    const nativeReceived = async () => {
      this.#rawNativeAvailable = true;
      await this.#sdkGate?.promise;
    };
    const loseDispatchReply = () => this.#loseDispatchReply;
    const nativeOutput = (id: string, output: string) => {
      // The fixed child emits only this non-secret readiness word before waiting.
      this.#nativeReadyPrefixes.set(
        id,
        ((this.#nativeReadyPrefixes.get(id) ?? "") + output).slice(
          0,
          "ready".length,
        ),
      );
    };
    const nativeOpened = (id: string, backend: string) =>
      this.#nativeBackends.set(id, backend);
    const nativeObserved = (id: string, backend: string) =>
      this.#observedNativeBackends.set(id, backend);
    const watcherGate = (id: string) => {
      if (!this.#carriagePresenters.has(id)) return undefined;
      const gate = this.#watcherDeliveryGate?.promise;
      if (gate !== undefined) this.#watcherOutputHeld = true;
      return gate;
    };
    const trace = (event: string) => this.#probeTrace.push(event);
    const probeAttempt = (id: string) => {
      if (!this.#probing || id !== this.#invocationId) return undefined;
      const attempt = ++this.#probeAttempt;
      trace(`get:${String(attempt)}`);
      return attempt;
    };
    function tracedHandle<E extends "utf8" | undefined>(
      handle: WorkspaceRuntimeExecHandle<E>,
      attempt?: number,
    ): WorkspaceRuntimeExecHandle<E> {
      // drainProcessExit/observeProcess consume the maintained native reader.
      // Hold original stdout delivery before UTF-8 prefetch reaches EOF.
      // An independent binary SDK reader witnesses exit without reading EOF.
      const getReader = handle.getReader.bind(handle);
      if (attempt !== undefined) {
        // The SDK's immutable disposal delegates to ordinary stream.cancel.
        // Observe that delegation without replacing result or Symbol.dispose.
        // That real producer calls cancel() without a reason.
        const cancel = handle.cancel.bind(handle);
        Object.defineProperty(handle, "cancel", {
          value: () => {
            trace(`cancel:${String(attempt)}`);
            return cancel();
          },
        });
      }
      Object.defineProperty(handle, "getReader", {
        value: () => {
          if (attempt !== undefined) trace(`reader:${String(attempt)}`);
          const reader = getReader();
          const read = reader.read.bind(reader);
          reader.read = async () => {
            if (attempt !== undefined) trace(`read:${String(attempt)}`);
            const next = await read();
            if (!next.done && next.value.name === "exit") {
              nativeExited(handle.id, next.value.code);
            }
            if (
              !next.done &&
              (next.value.name === "stdout" || next.value.name === "stderr")
            ) {
              const output = z.string().safeParse(next.value.value);
              if (output.success) {
                if (next.value.name === "stdout")
                  nativeOutput(handle.id, output.data);
                const gate =
                  attempt === undefined ? watcherGate(handle.id) : undefined;
                if (gate !== undefined) await gate;
              }
            }
            return next;
          };
          return reader;
        },
      });
      return handle;
    }
    function tracedExec(command: string): Promise<WorkspaceRuntimeExecHandle>;
    function tracedExec(
      command: string,
      options: WorkspaceRuntimeExecOptions<"utf8">,
    ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
    function tracedExec(
      command: string,
      options: WorkspaceRuntimeExecOptions,
    ): Promise<WorkspaceRuntimeExecHandle>;
    async function tracedExec(
      command: string,
      options: WorkspaceRuntimeExecOptions<"utf8" | undefined> = {},
    ): Promise<WorkspaceRuntimeExecHandle<"utf8" | undefined>> {
      if (command.startsWith("IFS= read -r value")) dispatched();
      const handle =
        options.encoding === "utf8"
          ? await exec(command, { ...options, encoding: "utf8" })
          : await exec(command, { ...options, encoding: undefined });
      if (command.startsWith("IFS= read -r value")) {
        await nativeReceived();
        if (loseDispatchReply()) {
          // The maintained SDK really spawned this invocation. Lose only its
          // client receipt/subscription, never fabricate a failed native start.
          handle[Symbol.dispose]();
          throw new Error("Fixture lost the native dispatch reply");
        }
      }
      nativeOpened(handle.id, handle.backend);
      return tracedHandle(handle);
    }
    function tracedGet(id: string): Promise<WorkspaceRuntimeExecHandle>;
    function tracedGet(
      id: string,
      options: WorkspaceRuntimeGetOptions<"utf8">,
    ): Promise<WorkspaceRuntimeExecHandle<"utf8">>;
    function tracedGet(
      id: string,
      options: WorkspaceRuntimeGetOptions,
    ): Promise<WorkspaceRuntimeExecHandle>;
    async function tracedGet(
      id: string,
      options: WorkspaceRuntimeGetOptions<"utf8" | undefined> = {},
    ): Promise<WorkspaceRuntimeExecHandle<"utf8" | undefined>> {
      probed();
      const attempt = probeAttempt(id);
      const handle =
        options.encoding === "utf8"
          ? await getExec(id, { ...options, encoding: "utf8" })
          : await getExec(id, { ...options, encoding: undefined });
      nativeObserved(handle.id, handle.backend);
      if (attempt !== undefined) trace(`acquired:${String(attempt)}`);
      return tracedHandle(handle, attempt);
    }
    runtime.exec = tracedExec;
    runtime.getExec = tracedGet;
    return workspace;
  }

  async #probeExecution(id = this.#invocationId): Promise<boolean | null> {
    if (id === undefined) return null;
    this.#invocationId = id;
    // This requires the frozen protected ABI's real implementation, not a
    // fixture fallback. Baseline tests fail on missing open before probing.
    this.#probeTrace = [];
    this.#probeAttempt = 0;
    this.#probing = true;
    try {
      return await this.executionIsLive(id);
    } finally {
      this.#probing = false;
    }
  }

  async #witnessNativeExit(): Promise<void> {
    const id = this.#invocationId;
    if (id === undefined) throw new Error("No admitted native exit to witness");
    let native: WorkspaceRuntimeExecHandle;
    try {
      // Undefined encoding keeps the SDK's lazy binary reader: no UTF-8 prefetch.
      native = await this.workspace().runtime.getExec(id, {
        backend: this.requireHostedRoute().id,
        encoding: undefined,
      });
    } catch (cause) {
      if (
        failedObservation(cause instanceof Error ? cause : undefined).state !==
        "running"
      )
        throw cause;
      this.#exitWitnessBusy++;
      Effect.runSync(
        Effect.logError(
          "Computer exit witness observed actual native subscriber contention",
          Redacted.make(cause),
        ),
      );
      return;
    }
    using handle = native;
    const reader = handle.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done)
          throw new Error("Native exit witness reached EOF without an exit");
        if (next.value.name === "exit") break;
      }
    } finally {
      // Cancel before EOF: the independent witness must not initiate post-pull.
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }

  #executionSnapshot() {
    const watchedOwner =
      this.#watchedProcessId === undefined
        ? undefined
        : this.state.storage.sql
            .exec<{ state: string }>(
              "SELECT state FROM computer_processes WHERE id = ?",
              this.#watchedProcessId,
            )
            .toArray()[0];
    const watchedInvocation =
      this.#watchedProcessId === undefined
        ? undefined
        : this.state.storage.sql
            .exec<{ phase: string }>(
              "SELECT phase FROM computer_execution_invocations WHERE id = ?",
              this.#watchedProcessId,
            )
            .toArray()[0];
    const invocation =
      this.#invocationId === undefined
        ? undefined
        : this.state.storage.sql
            .exec<{ phase: string }>(
              "SELECT phase FROM computer_execution_invocations WHERE id = ?",
              this.#invocationId,
            )
            .toArray()[0];
    const owner =
      this.#invocationId === undefined
        ? undefined
        : this.state.storage.sql
            .exec<{ state: string; started_at: number }>(
              "SELECT state, started_at FROM computer_processes WHERE id = ?",
              this.#invocationId,
            )
            .toArray()[0];
    return {
      watchedOwnerState: watchedOwner?.state ?? null,
      watchedInvocationPhase: watchedInvocation?.phase ?? null,
      watchedScopeRecords:
        this.state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM computer_processes WHERE request_scope = ?",
            this.#watchedScope,
          )
          .toArray()[0]?.count ?? null,
      invocationPhase: invocation?.phase ?? null,
      ownerState: owner?.state ?? null,
      ownerStartedAt: owner?.started_at ?? null,
      pullCalls: this.#pullCalls,
      pullsAtDispatch: this.#pullsAtDispatch,
      probeTrace: this.#probeTrace,
      watcherOutputHeld: this.#watcherOutputHeld,
      exitWitnessBusy: this.#exitWitnessBusy,
      nativeBackendRunning: this.state.container?.running ?? null,
      opens: this.#carriageOpens,
      renewals: this.#carriageRenewals,
      closes: this.#carriageCloses,
      nativeDispatches: this.#nativeDispatches,
      nativeProbes: this.#nativeProbes,
      workspaceReads: this.#workspaceReads,
      renewProofs: this.#renewProofs,
      startSettled: this.#startSettled,
      invocationId: this.#invocationId ?? null,
      processId: this.#process?.id ?? null,
      processState: this.#process?.state ?? null,
      processExitCode: this.#process?.exitCode ?? null,
      live: this.#live,
      execSettled: this.#execSettled,
      execSucceeded: this.#execSucceeded,
      execStatus: this.#execStatus ?? null,
      killSettled: this.#killSettled,
      killRejected: this.#killRejected,
      killSignalled: this.#killSignalled,
      startRejected: this.#startRejected,
      closeReasons: this.#closeReasons,
      closedBeforeCallbacks: this.#closedBeforeCallbacks,
      nativeExitBeforeCallbacks: this.#nativeExitBeforeCallbacks,
      rawNativeAvailable: this.#rawNativeAvailable,
      nativeExitCode:
        this.#invocationId === undefined
          ? null
          : (this.#nativeExitCodes.get(this.#invocationId) ?? null),
      nativeReady:
        this.#invocationId !== undefined &&
        this.#nativeReadyPrefixes.get(this.#invocationId) === "ready",
      ...this.#executionSqlObservation(),
    };
  }

  async #executionLaw(request: Request): Promise<Response> {
    const {
      action,
      requestId,
      processId,
      requestScope = "execution-law",
    } = z
      .strictObject({
        action: z.enum([
          "pending-process",
          "process",
          "refused-process",
          "release-open",
          "probe",
          "snapshot",
          "cleanup",
          "stop",
          "pending-exec",
          "replay-process",
          "exec",
          "exec-bytes",
          "cancel",
          "pending-sdk-process",
          "release-sdk",
          "ignored-term-process",
          "force-stop",
          "lost-reply-process",
          "reconcile",
          "evict",
          "pending-sdk-exec",
          "replay-sdk-exec",
          "held-exit-process",
          "release-exit",
          "witness-exit",
          "retain-anchor",
          "stop-anchor",
          "watch",
        ]),
        requestId: execRequestSchema.shape.requestId,
        processId: computerProcessIdSchema.optional(),
        requestScope: processStartInputSchema.shape.requestScope.optional(),
      })
      .parse(await request.json());
    if (action === "evict") {
      await this.state.storage.sync();
      this.state.abort("Computer native proof evicts only its JS isolate");
      throw new Error("Native proof eviction returned without terminating");
    }
    if (
      action === "pending-exec" ||
      action === "exec" ||
      action === "exec-bytes" ||
      action === "pending-sdk-exec" ||
      action === "replay-sdk-exec"
    ) {
      this.#binaryStdin = action === "exec-bytes";
      if (action === "pending-exec")
        this.#openGate = Promise.withResolvers<undefined>();
      if (action === "pending-sdk-exec")
        this.#sdkGate = Promise.withResolvers<undefined>();
      const execute: ComputerExecutionHostPort["executeOperationAfterAcceptance"] =
        this.executeOperationAfterAcceptance.bind(this);
      this.#pendingExec = execute(
        {
          requestId,
          command:
            action === "pending-sdk-exec" || action === "replay-sdk-exec"
              ? 'IFS= read -r value && test -n "$value" && test "$value" = "$HOST_ONLY_CARRIAGE" && exec sleep 600'
              : 'IFS= read -r value && test -n "$value" && test "$value" = "$HOST_ONLY_CARRIAGE" && printf carried',
          timeoutMs: 10_000,
        },
        () => undefined,
        "hosted",
        undefined,
        undefined,
        { kind: "carriage-proof" },
      )
        .then((operation) => {
          this.#execStatus = operation.status;
          this.#execSucceeded =
            operation.status === "succeeded" &&
            operation.output?.exitCode === 0 &&
            operation.output.stdout === "carried" &&
            operation.output.stderr === "";
        })
        .finally(() => {
          this.#execSettled = true;
        });
      this.state.waitUntil(this.#pendingExec);
      if (action !== "pending-exec" && action !== "pending-sdk-exec")
        await this.#pendingExec;
    }
    if (
      action === "pending-process" ||
      action === "process" ||
      action === "refused-process" ||
      action === "replay-process" ||
      action === "pending-sdk-process" ||
      action === "ignored-term-process" ||
      action === "lost-reply-process" ||
      action === "held-exit-process"
    ) {
      this.#refuseOpen = action === "refused-process";
      if (action === "pending-process")
        this.#openGate = Promise.withResolvers<undefined>();
      if (action === "pending-sdk-process")
        this.#sdkGate = Promise.withResolvers<undefined>();
      this.#ignoreTerm = action === "ignored-term-process";
      this.#loseDispatchReply = action === "lost-reply-process";
      if (action === "held-exit-process")
        this.#watcherDeliveryGate = Promise.withResolvers<undefined>();
      const start: ComputerExecutionHostPort["startProcessAfterAcceptance"] =
        this.startProcessAfterAcceptance.bind(this);
      this.#pendingProcess = start(
        {
          requestId,
          requestScope,
          command:
            action === "held-exit-process"
              ? 'IFS= read -r value && test -n "$value" && test "$value" = "$HOST_ONLY_CARRIAGE" && printf carried && printf held >&2'
              : this.#ignoreTerm
                ? 'IFS= read -r value && test -n "$value" && test "$value" = "$HOST_ONLY_CARRIAGE" && trap "" TERM && printf ready && while :; do sleep 1; done'
                : 'IFS= read -r value && test -n "$value" && test "$value" = "$HOST_ONLY_CARRIAGE" && exec sleep 600',
        },
        () => undefined,
        { kind: "carriage-proof" },
      )
        .then((process) => {
          this.#process = process;
        })
        .catch((cause: unknown) => {
          this.#startRejected = true;
          Effect.runSync(
            Effect.logError(
              "Computer execution proof observed a rejected process start",
              Redacted.make(cause),
            ),
          );
        })
        .finally(() => {
          this.#startSettled = true;
        });
      this.state.waitUntil(this.#pendingProcess);
      if (action !== "pending-process" && action !== "pending-sdk-process")
        await this.#pendingProcess;
    }
    if (action === "release-open") {
      this.#openGate?.resolve(undefined);
      await this.#pendingProcess;
      await this.#pendingExec;
    }
    if (action === "probe") this.#live = await this.#probeExecution(processId);
    if (action === "retain-anchor") {
      if (this.#process === undefined)
        throw new Error("No admitted process to retain as the native anchor");
      this.#retentionAnchor = this.#process;
    }
    if (action === "stop-anchor") {
      if (this.#retentionAnchor === undefined)
        throw new Error("No native retention anchor to stop");
      this.#invocationId = this.#retentionAnchor.id;
      await this.killProcess({ id: this.#retentionAnchor.id });
    }
    if (action === "watch") {
      if (processId === undefined)
        throw new Error("No public process identity to observe");
      this.#watchedProcessId = processId;
      this.#watchedScope = requestScope;
    }
    if (action === "reconcile") {
      const id = processId ?? this.#process?.id ?? this.#invocationId;
      const listed = await this.listProcesses();
      this.#process = listed.processes.find((process) => process.id === id);
    }
    if (action === "release-sdk") {
      this.#sdkGate?.resolve(undefined);
      await this.#pendingProcess;
      await this.#pendingKill;
    }
    if (action === "cancel") {
      if (this.#invocationId === undefined)
        throw new Error("No admitted invocation to cancel");
      this.#pendingKill = this.killProcess({ id: this.#invocationId })
        .then((result) => {
          this.#killSignalled = result.signalled;
        })
        .catch((cause: unknown) => {
          this.#killRejected = true;
          Effect.runSync(
            Effect.logError(
              "Computer execution proof observed a rejected kill request",
              Redacted.make(cause),
            ),
          );
        })
        .finally(() => {
          this.#killSettled = true;
        });
      this.state.waitUntil(this.#pendingKill);
    }
    if (action === "force-stop") {
      if (this.#invocationId === undefined)
        throw new Error("No admitted invocation to terminate");
      await this.workspace().runtime.killExec(this.#invocationId, {
        backend: this.requireHostedRoute().id,
        signal: "SIGKILL",
      });
    }
    if (action === "witness-exit") await this.#witnessNativeExit();
    if (action === "release-exit")
      this.#watcherDeliveryGate?.resolve(undefined);
    if (action === "cleanup" || action === "stop") {
      this.#watcherDeliveryGate?.resolve(undefined);
      this.#openGate?.resolve(undefined);
      this.#sdkGate?.resolve(undefined);
      await this.#pendingProcess;
      await this.#pendingExec;
      await this.#pendingKill;
      if (
        this.#retentionAnchor !== undefined &&
        this.#retentionAnchor.id !== this.#process?.id &&
        !this.#nativeExitEvents.has(this.#retentionAnchor.id)
      )
        await this.killProcess({ id: this.#retentionAnchor.id });
      if (
        this.#process !== undefined &&
        this.#process.state !== "exited" &&
        !this.#nativeExitEvents.has(this.#process.id)
      ) {
        if (this.#ignoreTerm) {
          if (!this.#nativeExitEvents.has(this.#process.id))
            await this.workspace().runtime.killExec(this.#process.id, {
              backend: this.requireHostedRoute().id,
              signal: "SIGKILL",
            });
        } else await this.killProcess({ id: this.#process.id });
      }
    }
    return Response.json(this.#executionSnapshot());
  }

  #executionSqlObservation() {
    // These are the actual application owners for this pinned production
    // checkpoint. Platform-private storage is not part of their SQL interface.
    const executions = this.state.storage.sql
      .exec<{
        id: string;
        backend: string;
        native_opened: number;
        context_json: string;
      }>("SELECT * FROM computer_execution_invocations")
      .toArray();
    const operations = this.state.storage.sql
      .exec("SELECT * FROM computer_operations")
      .toArray();
    const processes = this.state.storage.sql
      .exec<{ id: string }>("SELECT * FROM computer_processes")
      .toArray();
    const secrets = [...this.#carriagePresenters.values()];
    const observed =
      executions.length !== 0 && operations.length + processes.length !== 0;
    const stored = JSON.stringify({ executions, operations, processes });
    return {
      lifecycleIds: executions.map((row) => row.id),
      processOwnerIds: processes.map((row) => row.id),
      sqlSecretFree:
        secrets.length === 0 || !observed
          ? null
          : secrets.every((secret) => !stored.includes(secret)),
      sqlBackendReceipt:
        this.#carriagePresenters.size === 0
          ? null
          : [...this.#carriagePresenters.keys()].every((id) =>
              executions.some(
                (row) =>
                  row.id === id &&
                  row.backend === this.#selectedBackends.get(id) &&
                  row.native_opened ===
                    (this.#nativeBackends.has(id) ? 1 : 0) &&
                  (!this.#nativeBackends.has(id) ||
                    row.backend === this.#nativeBackends.get(id)),
              ),
            ),
      sqlPublicContext:
        this.#carriagePresenters.size !== 0 &&
        executions.length !== 0 &&
        executions.every(
          (row) =>
            z
              .strictObject({ kind: z.literal("carriage-proof") })
              .safeParse(JSON.parse(row.context_json)).success,
        ),
    };
  }

  /** Test host cargo stays in memory; no test route accepts or returns it. */
  protected override executionHooks(): ComputerExecutionHostHooks {
    return {
      open: async (invocation, context) => {
        z.strictObject({ kind: z.literal("carriage-proof") }).parse(context);
        this.#invocationId = invocation.id;
        this.#selectedBackends.set(invocation.id, this.requireHostedRoute().id);
        const secret = crypto.randomUUID();
        this.#carriagePresenters.set(invocation.id, secret);
        this.#carriageOpens++;
        if (this.#refuseOpen) throw new Error("Fixture host issuance refused");
        await this.#openGate?.promise;
        return {
          env: { HOST_ONLY_CARRIAGE: secret },
          stdin: this.#binaryStdin
            ? new TextEncoder().encode(`${secret}\n`)
            : `${secret}\n`,
        };
      },
      renew: () => {
        this.#carriageRenewals++;
        this.#renewProofs.push(this.#nativeProbes > 0);
        return Promise.resolve();
      },
      close: (invocation, _context, reason) => {
        this.#nativeExitBeforeCallbacks.push(
          reason === "native_exit"
            ? this.#nativeExitEvents.has(invocation.id)
            : null,
        );
        this.#invocationId = invocation.id;
        this.#closedBeforeCallbacks.push(
          this.#durablyClosed(invocation.id, reason),
        );
        this.#closeReasons.push(reason);
        this.#carriageCloses++;
        return Promise.resolve();
      },
    };
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test-execution-law" && request.method === "POST")
      return await this.#executionLaw(request);
    if (
      url.pathname === "/test-execution-carriage" &&
      request.method === "POST"
    ) {
      const { requestId } = execRequestSchema
        .pick({ requestId: true })
        .parse(await request.json());
      const execute: ComputerExecutionHostPort["executeOperationAfterAcceptance"] =
        this.executeOperationAfterAcceptance.bind(this);
      const operation = await execute(
        {
          requestId,
          command:
            'IFS= read -r value && test -n "$value" && test "$value" = "$HOST_ONLY_CARRIAGE" && printf carried',
          timeoutMs: 10_000,
        },
        () => undefined,
        "hosted",
        undefined,
        undefined,
        { kind: "carriage-proof" },
      );
      return Response.json({
        operation,
        opens: this.#carriageOpens,
        renewals: this.#carriageRenewals,
        closes: this.#carriageCloses,
        ...this.#executionSqlObservation(),
      });
    }
    if (url.pathname === "/test-process-start" && request.method === "POST") {
      return Response.json(
        await this.startProcessAfterAcceptance(
          z.json().parse(await request.json()),
          () => undefined,
        ),
      );
    }
    if (url.pathname === "/test-operation" && request.method === "POST") {
      const appMethod = url.searchParams.has("appMethod");
      const abortAfter = z.coerce
        .number()
        .int()
        .min(1)
        .max(5_000)
        .optional()
        .parse(url.searchParams.get("abortAfterMs") ?? undefined);
      const cancellation = new AbortController();
      const timer =
        abortAfter === undefined
          ? undefined
          : setTimeout(() => {
              cancellation.abort(
                new DOMException("App execution wait expired", "TimeoutError"),
              );
            }, abortAfter);
      try {
        return Response.json(
          await this.executeOperationAfterAcceptance(
            execRequestSchema.parse(await request.json()),
            () => {
              if (url.searchParams.has("denyAcceptance"))
                throw new Error("Fixture execution acceptance refused");
            },
            appMethod ? "bash" : "exec",
            appMethod ? { maximumTimeMs: 45_000 } : undefined,
            appMethod ? cancellation.signal : undefined,
          ),
        );
      } catch (error) {
        const invalid =
          error instanceof z.ZodError ||
          error instanceof ComputerRequestInvalidError;
        const conflict = error instanceof ComputerOperationConflictError;
        return Response.json(
          { error: invalid ? "invalid" : conflict ? "conflict" : "failed" },
          { status: invalid ? 400 : conflict ? 409 : 500 },
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (
      url.pathname.startsWith("/test-operation-status/") &&
      request.method === "GET"
    ) {
      try {
        return Response.json(
          this.getOperationStatusAfterAcceptance(
            url.pathname.slice("/test-operation-status/".length),
            () => undefined,
          ),
        );
      } catch {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
    }
    if (url.pathname === "/test-fill-operations" && request.method === "POST") {
      const input = z
        .strictObject({ requestId: z.uuid() })
        .parse(await request.json());
      // Seed a full record set accepted outside the admission window.
      const acceptedAt = Date.now() - 10 * 60 * 1_000;
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS computer_operations (request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'succeeded', 'failed', 'unknown')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, output_expires_at INTEGER NOT NULL, output_json TEXT) STRICT",
      );
      this.state.storage.sql.exec("DELETE FROM computer_operations");
      // Offset the seed's 12 random version-field bits so no filler record
      // can reproduce the seed's own request ID.
      const seedBits = Number.parseInt(input.requestId.slice(15, 18), 16);
      for (let index = 0; index < 500; index += 1) {
        const requestId =
          index === 0
            ? input.requestId
            : `${input.requestId.slice(0, 15)}${((seedBits + index) % 0x1000).toString(16).padStart(3, "0")}${input.requestId.slice(18)}`;
        const createdAt = index === 0 ? acceptedAt - 1_000 : acceptedAt;
        this.state.storage.sql.exec(
          "INSERT INTO computer_operations (request_id, input_hash, status, created_at, updated_at, output_expires_at, output_json) VALUES (?, 'proof', 'succeeded', ?, ?, ?, NULL)",
          requestId,
          createdAt,
          createdAt,
          createdAt + 86_400_000,
        );
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/test-container-running") {
      const hosted = this.hostedRoute();
      return Response.json({
        running:
          hosted !== undefined && (await this.containerRunning(hosted.backing)),
      });
    }
    if (url.pathname === "/test-pty") {
      const principalKey = url.searchParams.get("principal") ?? "member-one";
      return await this.terminalAfterAcceptance(
        request,
        principalKey,
        () => undefined,
      );
    }
    const preview = /^\/test-port-preview\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (preview !== null) {
      const port = Number(preview[1]);
      const path = preview[2] ?? "/";
      const serviceUrl = new URL("http://localhost");
      serviceUrl.pathname = path;
      serviceUrl.search = url.search;
      const previewRequest = new Request(serviceUrl, request);
      if (path === "/__proof_websocket_upgrade")
        previewRequest.headers.set("Upgrade", "websocket");
      return await this.portPreviewAfterAcceptance(
        port,
        previewRequest,
        () => undefined,
      );
    }
    return await super.fetch(request);
  }
}

type Env = OnBoxVmEnv &
  Readonly<{
    COMPUTER: ComputerNamespace &
      Pick<DurableObjectNamespace, "idFromString" | "idFromName" | "get">;
  }>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const callInput = z.strictObject({
  capability: z.string().min(1),
  input: z.json(),
});
const replaceInput = z.strictObject({
  path: z.string().min(1),
  expectedContent: z.string(),
  content: z.string(),
});
const filesReadInput = z.strictObject({
  path: z.string().min(1),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(4).positive(),
});

function rejectedName(operation: Promise<unknown>): Promise<string> {
  return operation.then(
    () => "none",
    (cause: unknown) => (cause instanceof Error ? cause.name : String(cause)),
  );
}

async function assertCancelledReplace(computer: ComputerRpc): Promise<void> {
  let replacementCalls = 0;
  // SAFETY: this proof calls only the replacement path, whose sole Computer member is supplied below.
  const countedComputer = {
    async replaceFileIfUnchanged(
      input: Parameters<ComputerRpc["replaceFileIfUnchanged"]>[0],
    ) {
      replacementCalls += 1;
      return await computer.replaceFileIfUnchanged(input);
    },
  } as ComputerRpc;
  const port = createComputerFilesPort(countedComputer);
  const cancellation = new AbortController();
  cancellation.abort();
  const rejectionName = await rejectedName(
    port.replace(
      { path: "/never.txt", expectedContent: "before", content: "after" },
      {
        executionId: "cancelled-before-replace",
        deadlineAt: null,
        signal: cancellation.signal,
      },
    ),
  );
  if (rejectionName !== "AbortError") {
    throw new Error("Computer Files accepted an already-aborted replacement");
  }
  if (replacementCalls !== 0) {
    throw new Error(
      "Computer Files started an already-aborted replacement RPC",
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const onBoxVm = onBoxVmIngress(request, env, env.COMPUTER);
    if (onBoxVm !== undefined) return await onBoxVm;
    const computer = env.COMPUTER.getByName("proof-home");
    const url = new URL(request.url);
    if (url.pathname === "/binary-file") {
      const path = z.string().parse(url.searchParams.get("path"));
      if (request.method === "PUT") {
        if (request.body === null)
          return new Response("File body required", { status: 400 });
        using workspace = await getWorkspace(computer);
        await workspace.fs.writeFile(path, request.body);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const content = await computer.readFile({ path });
        if (url.searchParams.has("slow")) await wait(250);
        return new Response(content);
      }
    }
    if (url.pathname === "/files/write" && request.method === "PUT") {
      // Inkcap's path: the DO's own write method, not the `getWorkspace` stub.
      const path = z.string().parse(url.searchParams.get("path"));
      if (request.body === null)
        return new Response("File body required", { status: 400 });
      // SAFETY: the Cloudflare ambient Request type omits ReadableStream's
      // generic; this body is the HTTP request's raw Uint8Array chunks.
      const body = request.body as ReadableStream<Uint8Array>;
      await computer.writeFile({ path }, body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/capabilities" && request.method === "GET") {
      await assertCancelledReplace(computer);
      return Response.json(await computer.getCapabilities());
    }
    if (url.pathname === "/container-running") {
      // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL("/test-container-running", request.url), request),
      );
    }
    if (url.pathname === "/pty") {
      // SAFETY: This is a test Worker and `computer` is the RPC stub returned by the bound DO namespace.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL(`/test-pty${url.search}`, request.url), request),
      );
    }
    if (url.pathname === "/ports" && request.method === "GET") {
      return Response.json(await computer.listPorts());
    }
    if (url.pathname === "/ports/expose" && request.method === "POST") {
      const input = z
        .strictObject({ port: z.number() })
        .parse(await request.json());
      try {
        return Response.json(await computer.exposePort(input));
      } catch (error) {
        // Workers RPC keeps the message, not the ComputerPortReservedError class.
        if (
          isComputerReservedPort(input.port) &&
          error instanceof Error &&
          error.message.includes("is reserved")
        )
          return Response.json({ error: "port is reserved" }, { status: 400 });
        throw error;
      }
    }
    if (url.pathname === "/ports/unexpose" && request.method === "POST") {
      return Response.json(
        await computer.unexposePort(
          z.strictObject({ port: z.number() }).parse(await request.json()),
        ),
      );
    }
    if (url.pathname.startsWith("/port-preview/")) {
      // SAFETY: this is a test Worker calling the Computer DO's test-only fetch seam.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(
          new URL(
            `/test-port-preview/${url.pathname.slice("/port-preview/".length)}${url.search}`,
            request.url,
          ),
          request,
        ),
      );
    }
    if (url.pathname === "/host-process-start" && request.method === "POST") {
      // SAFETY: the fixture's named DO binding reaches its test-only protected host seam.
      const stub = computer as ComputerRpc & {
        fetch: (request: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL("/test-process-start", request.url), request),
      );
    }
    if (url.pathname === "/call" && request.method === "POST") {
      const input = callInput.parse(await request.json());
      return Response.json(await computer.call(input.capability, input.input));
    }
    if (url.pathname === "/test-fill-operations" && request.method === "POST") {
      // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL("/test-fill-operations", request.url), request),
      );
    }
    if (url.pathname === "/operation" && request.method === "POST") {
      // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(
          new URL(`/test-operation${url.search}`, request.url),
          request,
        ),
      );
    }
    if (url.pathname === "/execution-carriage" && request.method === "POST") {
      // The named proof actor owns the protected host context, not the request.
      const stub = env.COMPUTER.get(env.COMPUTER.idFromName("carriage-proof"));
      return await stub.fetch(
        new Request(new URL("/test-execution-carriage", request.url), request),
      );
    }
    if (url.pathname === "/execution-law" && request.method === "POST") {
      const stub = env.COMPUTER.get(env.COMPUTER.idFromName("execution-law"));
      return await stub.fetch(
        new Request(new URL("/test-execution-law", request.url), request),
      );
    }
    if (
      url.pathname.startsWith("/operation-status/") &&
      request.method === "GET"
    ) {
      try {
        // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
        const stub = computer as ComputerRpc & {
          fetch: (input: Request) => Promise<Response>;
        };
        return await stub.fetch(
          new Request(
            new URL(
              `/test-operation-status/${url.pathname.slice("/operation-status/".length)}`,
              request.url,
            ),
            request,
          ),
        );
      } catch {
        return Response.json({ error: "unavailable" }, { status: 500 });
      }
    }
    if (url.pathname === "/replace" && request.method === "POST") {
      return Response.json(
        await computer.replaceFileIfUnchanged(
          replaceInput.parse(await request.json()),
        ),
      );
    }
    if (url.pathname === "/files/read" && request.method === "POST") {
      using workspace = await getWorkspace(computer);
      const port = createWorkspaceFilesPort(workspace, computer);
      return Response.json(
        await port.read(filesReadInput.parse(await request.json())),
      );
    }
    if (url.pathname === "/files/replace" && request.method === "POST") {
      using workspace = await getWorkspace(computer);
      const port = createWorkspaceFilesPort(workspace, computer);
      return Response.json(
        await port.replace(replaceInput.parse(await request.json())),
      );
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
