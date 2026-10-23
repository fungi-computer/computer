import * as Data from "effect/Data";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import type {
  ComputerDO as NativeComputerDO,
  OnBoxVmContainerHost,
} from "../index.js";
import { computerContainerSleepAfterMs } from "../container-policy.js";
import {
  attachedBackendId,
  type ContainerRuntimeStart,
  type HostedBacking,
  type AttachedBackend,
  type AttachedBackendView,
} from "../computer-backends.js";
import { z } from "zod";
import { ComputerRuntimeUsage } from "./runtime-usage.js";
import { checkComputerGrant } from "./admission.js";
import type { ComputerGrant } from "./wire.js";

/** Runtime observations consumed by the host; never host callbacks. */
export type FleetLifecycleFact =
  | Readonly<{ kind: "reservation.release" | "reservation.monitor" }>
  | Readonly<{
      kind: "diagnostic";
      event: string;
      code: string;
      cause?: unknown;
    }>;
/** Native runtime and storage capabilities, without host policy or settlement. */
export type FleetLifecyclePorts = Readonly<{
  storage: WatchdogSqliteOwner &
    Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;
  alarm: Pick<DurableObjectState, "waitUntil">;
  computerId: string | undefined;
  runtimeWatchMs: string | undefined;
  backend: Readonly<{
    state: Pick<DurableObjectState, "id" | "waitUntil"> & {
      container?: Pick<
        NonNullable<DurableObjectState["container"]>,
        "running" | "monitor" | "destroy"
      >;
    };
    onBoxVmHost: (
      hostId: string,
    ) => Pick<OnBoxVmContainerHost, "state" | "inventory" | "destroy">;
    hostedContainerHost: (
      backing: HostedBacking,
    ) => Pick<ReturnType<NativeComputerDO["getWorkspaceContainer"]>, "restart">;
    readyWorkspace: () => Promise<{
      push: (id: string) => Promise<number>;
      pull: (id: string) => Promise<object>;
    }>;
    workspace: () => { push: (id: string) => Promise<number> };
    syncRecycledWorkspace: (backing: HostedBacking) => Promise<void>;
    attachedBackends: () => readonly AttachedBackend[];
    describeBackends: () => AttachedBackendView[];
    requireHostedRoute: () => { backing: HostedBacking; id: string };
    containerRunning: (backing: HostedBacking) => Promise<boolean>;
    vmQueuePosition: (hostId: string) => Promise<number | null>;
  }>;
}>;

const vmRecycleAfterMs = 23 * 60 * 60 * 1_000;
const vmRecycleQuietMs = 30_000;
const runtimeWatchSchema = z.lazy(() =>
  z.coerce.number().int().min(1_000).max(3_600_000).catch(60_000),
);
function runtimeWatchDelay(
  delivered: boolean,
  running: number,
  watchMs: number,
): number | null {
  if (running > 0) return delivered ? watchMs : 1_000;
  return delivered ? null : 30_000;
}

class ComputerVmRecycleError extends Data.TaggedError(
  "ComputerVmRecycleError",
)<{
  readonly cause: unknown;
}> {}

/** A grant refused before native execution. The host maps it to its public error. */
export class FleetGrantRefused extends Error {
  constructor() {
    super("Computer grant refused");
    this.name = "FleetGrantRefused";
  }
}

/** Runtime activity, interval observations and recycling under host-issued grants. */
export class FleetLifecycle {
  readonly usage: ComputerRuntimeUsage;
  readonly #watchMs: number;
  #hostedOperations = 0;
  #startingHosted = 0;
  #lastHostedActivity = Date.now();
  #recycling: Promise<ComputerVmRecycleError | undefined> | undefined;
  #recycleRuntimeId: string | undefined;
  #facts: FleetLifecycleFact[] = [];

  constructor(private readonly ports: FleetLifecyclePorts) {
    this.#watchMs = runtimeWatchSchema.parse(ports.runtimeWatchMs ?? 60_000);
    this.usage = new ComputerRuntimeUsage(ports.storage.sql, this.#watchMs);
  }
  get recycleRuntimeId(): string | undefined {
    return this.#recycleRuntimeId;
  }
  /** A successful stop cannot race an admitted boot or in-flight operation. */
  get hasPendingOperations(): boolean {
    return (
      this.#hostedOperations > 0 ||
      this.#startingHosted > 0 ||
      this.#recycling !== undefined
    );
  }
  takeFacts(): FleetLifecycleFact[] {
    const facts = this.#facts;
    this.#facts = [];
    return facts;
  }
  private diagnostic(event: string, code: string, cause?: unknown): void {
    this.#facts.push({ kind: "diagnostic", event, code, cause });
  }
  /** Keep pending starts visible while the host obtains admission and capacity. */
  private beginHostedStart(): () => void {
    this.#startingHosted++;
    return () => {
      this.#startingHosted--;
    };
  }

  /** Start the selected hosted backend under the host's admission and slot policy. */
  async startHostedComputer(
    admitted: (
      backing: HostedBacking,
      run: () => Promise<void>,
    ) => Promise<void>,
  ) {
    const hosted = this.ports.backend.requireHostedRoute();
    const finish = this.beginHostedStart();
    try {
      await admitted(hosted.backing, async () => {
        await this.ports.backend.workspace().push(hosted.id);
      });
      if (!(await this.ports.backend.containerRunning(hosted.backing)))
        throw new Error("Hosted Computer disconnected while starting");
      return { state: "running" as const };
    } finally {
      finish();
    }
  }

  /** Read liveness without waking a sleeping backend. Queue state wins over booting. */
  async readComputerState() {
    const backends = await this.readAttachedBackends();
    const position = backends.find(
      (backend) => backend.queuePosition !== null,
    )?.queuePosition;
    if (position != null) return { state: "queued" as const, position };
    if (this.#startingHosted > 0) return { state: "starting" as const };
    for (const backing of this.ports.backend.attachedBackends()) {
      if (backing.kind === "on-box-vm") {
        const runtime = await this.ports.backend
          .onBoxVmHost(backing.hostId)
          .state();
        if (runtime.running)
          return {
            state:
              runtime.runtimeId === null
                ? ("starting" as const)
                : ("running" as const),
          };
      } else if (
        backing.kind === "platform-container" &&
        (await this.ports.backend.containerRunning(backing))
      ) {
        return { state: "running" as const };
      }
    }
    return {
      state: backends.some((backend) => backend.status === "online")
        ? ("running" as const)
        : ("sleeping" as const),
    };
  }

  /** The Computer page's read: each attached backend and its live status. */
  async readAttachedBackends(): Promise<
    (Omit<AttachedBackendView, "status"> & {
      status: AttachedBackendView["status"] | "queued";
      queuePosition: number | null;
    })[]
  > {
    return await Promise.all(
      this.ports.backend.describeBackends().map(async (backend) => {
        const queuePosition =
          backend.kind === "on-box-vm" && backend.hostId !== undefined
            ? await this.ports.backend.vmQueuePosition(backend.hostId)
            : null;
        return {
          ...backend,
          status: queuePosition === null ? backend.status : ("queued" as const),
          queuePosition,
        };
      }),
    );
  }

  /** Native execution remains the callback; policy has already become a grant. */
  async run<T>(
    grant: ComputerGrant,
    backing: HostedBacking,
    run: () => Promise<T>,
  ): Promise<T> {
    await this.awaitRecycle();
    if (
      checkComputerGrant(grant, {
        computerId: this.ports.computerId ?? "",
        action: "start",
        now: Date.now(),
      }).kind !== "admitted"
    )
      throw new FleetGrantRefused();
    this.#hostedOperations++;
    try {
      if (backing.kind === "platform-container")
        this.usage.touchActivity(backing, Date.now());
      return await run();
    } finally {
      this.#hostedOperations--;
      this.#lastHostedActivity = Date.now();
      if (backing.kind === "platform-container")
        this.usage.touchActivity(backing, this.#lastHostedActivity);
      if (backing.kind === "on-box-vm") {
        if (!this.usage.hasOpen(backing))
          this.#facts.push({ kind: "reservation.release" });
      } else {
        this.#facts.push({
          kind: this.ports.backend.state.container?.running
            ? "reservation.monitor"
            : "reservation.release",
        });
      }
    }
  }
  /** Transport traffic advances activity; an idle open connection does not. */
  trackResponse(backing: HostedBacking, response: Response): Response {
    const socket = response.webSocket ?? null;
    if (socket === null && response.body === null) return response;
    let lastRecordedAt = Date.now();
    const recordTraffic = () => {
      const now = Date.now();
      if (now - lastRecordedAt < 30_000) return;
      lastRecordedAt = now;
      this.#lastHostedActivity = now;
      if (backing.kind === "platform-container")
        this.usage.touchActivity(backing, now);
    };
    if (socket !== null) {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const close = (event: CloseEvent) => {
        const code =
          event.code === 1000 || (event.code >= 3000 && event.code <= 4999)
            ? event.code
            : 1000;
        if (socket.readyState === WebSocket.OPEN)
          socket.close(code, event.reason);
        if (server.readyState === WebSocket.OPEN)
          server.close(code, event.reason);
      };
      const fail = () => {
        if (socket.readyState === WebSocket.OPEN)
          socket.close(1000, "Terminal transport failed");
        if (server.readyState === WebSocket.OPEN)
          server.close(1000, "Terminal transport failed");
      };
      socket.addEventListener(
        "message",
        (event: { data: string | ArrayBuffer }) => {
          recordTraffic();
          server.send(event.data);
        },
      );
      server.addEventListener(
        "message",
        (event: { data: string | ArrayBuffer }) => {
          recordTraffic();
          socket.send(event.data);
        },
      );
      socket.addEventListener("close", close, { once: true });
      server.addEventListener("close", close, { once: true });
      socket.addEventListener("error", fail, { once: true });
      server.addEventListener("error", fail, { once: true });
      // Workers delivers binary frames as Blob by default; send accepts bytes.
      socket.binaryType = "arraybuffer";
      server.binaryType = "arraybuffer";
      socket.accept();
      server.accept();
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: response.headers,
      });
    }
    const reader = response.body?.getReader();
    if (reader === undefined) {
      return response;
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            controller.close();
          } else {
            const chunk = z.instanceof(Uint8Array).parse(result.value);
            if (chunk.byteLength > 0) recordTraffic();
            controller.enqueue(chunk);
          }
        } catch (cause) {
          controller.error(cause);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  containerRuntimeStarted(start: ContainerRuntimeStart): void {
    this.usage.started(start);
    this.ports.alarm.waitUntil(
      this.armRuntimeWatch(Date.now() + this.#watchMs),
    );
  }

  async armRuntimeWatch(due: number): Promise<void> {
    const alarm = await this.ports.storage.getAlarm();
    if (alarm === null || alarm > due) await this.ports.storage.setAlarm(due);
  }

  async syncRecycledWorkspace(backing: HostedBacking): Promise<void> {
    const workspace = await this.ports.backend.readyWorkspace();
    const id = attachedBackendId(backing);
    await workspace.push(id);
    await workspace.pull(id);
  }

  private async finishVmRecycle(): Promise<void> {
    for (const row of this.usage.pendingRecycles()) {
      const backing = row.backing;
      const current = await this.ports.backend
        .onBoxVmHost(backing.hostId)
        .state();
      if (!(current.running && current.runtimeId === row.runtimeId)) {
        this.usage.observe(row.runtimeId, {
          running: false,
          endedAt: row.requestedAt,
        });
        if (current.running && current.runtimeId !== null)
          this.containerRuntimeStarted({
            runtimeId: current.runtimeId,
            backing,
            startedAt: Date.now(),
          });
      }
      if (
        !current.running &&
        this.#hostedOperations === 0 &&
        !this.usage.hasAnyOpen()
      )
        this.#facts.push({ kind: "reservation.release" });
      this.usage.finishRecycle(row.runtimeId);
    }
  }

  private async recycleQuietVms(grant: ComputerGrant | null): Promise<void> {
    if (
      this.#hostedOperations > 0 ||
      Date.now() - this.#lastHostedActivity < vmRecycleQuietMs
    )
      return;
    const candidates = this.usage.recycleCandidates(
      Date.now() - vmRecycleAfterMs,
    );
    for (const row of candidates) {
      const backing = row.backing;
      if (
        backing.kind !== "on-box-vm" ||
        grant === null ||
        checkComputerGrant(grant, {
          computerId: this.ports.computerId ?? "",
          action: "start",
          now: Date.now(),
        }).kind !== "admitted"
      )
        continue;
      const inventory = await this.ports.backend
        .onBoxVmHost(backing.hostId)
        .inventory();
      const vm = inventory.find(
        (entry) => entry.id === this.ports.backend.state.id.toString(),
      );
      if (
        vm === undefined ||
        !vm.running ||
        vm.runtimeId !== row.runtimeId ||
        Date.now() - vm.lastActive < vmRecycleQuietMs
      )
        continue;
      this.#recycleRuntimeId = row.runtimeId;
      try {
        await this.ports.backend.syncRecycledWorkspace(backing);
        const current = await this.ports.backend
          .onBoxVmHost(backing.hostId)
          .state();
        if (!current.running || current.runtimeId !== row.runtimeId) continue;
        this.usage.requestRecycle(row.runtimeId, backing, Date.now());
        await this.armRuntimeWatch(Date.now() + vmRecycleQuietMs);
        const started = await this.ports.backend
          .hostedContainerHost(backing)
          .restart({}, false);
        this.#recycleRuntimeId = started.runtimeId;
        await this.finishVmRecycle();
        await this.ports.backend.syncRecycledWorkspace(backing);
      } finally {
        this.#recycleRuntimeId = undefined;
        await this.finishVmRecycle();
      }
    }
  }

  private async observeRuntime(
    runtimeId: string,
    backing: HostedBacking,
    newest: boolean,
  ): Promise<{ running: boolean; endedAt: number }> {
    const now = Date.now();
    if (backing.kind === "platform-container") {
      const container = this.ports.backend.state.container;
      if (newest && container?.running === true) {
        const deadline = this.usage.idleDeadline(
          runtimeId,
          computerContainerSleepAfterMs,
          now,
        );
        if (
          deadline !== null &&
          this.#hostedOperations === 0 &&
          now >= deadline
        ) {
          try {
            await container.destroy(new Error("Computer idle timeout"));
          } catch (cause) {
            this.diagnostic("computer_idle_stop_failed", "idle_stop", cause);
            return { running: true, endedAt: now };
          }
          return { running: false, endedAt: deadline };
        }
        return { running: true, endedAt: now };
      }
      return { running: false, endedAt: now };
    }
    const state = await this.ports.backend.onBoxVmHost(backing.hostId).state();
    return {
      running: state.running && state.runtimeId === runtimeId,
      endedAt: state.exit?.exitedAt ?? now,
    };
  }

  async awaitRecycle(): Promise<void> {
    const error = await this.#recycling;
    if (error !== undefined) throw error;
  }

  /** Reconcile durable observations before the host delivers usage facts. */
  async observe(): Promise<HostedBacking[]> {
    await this.#recycling;
    this.usage.ensure();
    await this.finishVmRecycle();
    return this.observeOpenRuntimes();
  }

  /** The host supplies current permission; this owner chooses quiet runtime candidates. */
  async recycle(grant: ComputerGrant | null): Promise<void> {
    if (this.#recycling !== undefined) return;
    const recycling = this.recycleQuietVms(grant).then(
      () => undefined,
      (cause: unknown) => {
        const error = new ComputerVmRecycleError({ cause });
        this.diagnostic("computer_vm_recycle_failed", "vm_recycle", error);
        return error;
      },
    );
    this.#recycling = recycling;
    try {
      await recycling;
    } finally {
      this.#recycling = undefined;
    }
  }

  async watch(delivered: boolean, running: number): Promise<void> {
    const delay = runtimeWatchDelay(delivered, running, this.#watchMs);
    if (delay !== null)
      await this.armRuntimeWatch(Date.now() + this.recycleWatchDelay(delay));
  }
  private recycleWatchDelay(delay: number): number {
    const oldest = this.usage.oldestVmStart();
    if (oldest === null) return delay;
    return Math.min(
      delay,
      Math.max(vmRecycleQuietMs, oldest + vmRecycleAfterMs - Date.now()),
    );
  }

  private async observeOpenRuntimes(): Promise<HostedBacking[]> {
    const open = this.usage.open();
    const runningBackings: HostedBacking[] = [];
    for (const [index, row] of open.entries()) {
      const observed = await this.observeRuntime(
        row.runtimeId,
        row.backing,
        index === 0,
      );
      if (observed.running) runningBackings.push(row.backing);
      this.usage.observe(row.runtimeId, observed);
    }
    if (
      open.length > 0 &&
      this.#hostedOperations === 0 &&
      runningBackings.length === 0
    )
      this.#facts.push({ kind: "reservation.release" });
    return runningBackings;
  }

  /** Stop requested backends; failures remain host-readable observations. */
  async stop(runningBackings: readonly HostedBacking[]): Promise<void> {
    const stopped = await Promise.allSettled(
      runningBackings.map((backing) => this.destroyRuntime(backing)),
    );
    if (stopped.some((result) => result.status === "rejected"))
      this.diagnostic("computer_usage_stop_failed", "usage_stop");
  }

  /** Stop all known runtimes and report any still running. */
  async stopAll(reason: string): Promise<HostedBacking[]> {
    this.usage.ensure();
    const backings = this.usage.open().map(({ backing }) => backing);
    await Promise.all(backings.map((backing) => this.destroyRuntime(backing)));
    if (
      this.ports.backend.state.container?.running === true &&
      backings.length === 0
    )
      await this.ports.backend.state.container.destroy(new Error(reason));
    return this.observeOpenRuntimes();
  }
  private async destroyRuntime(backing: HostedBacking): Promise<void> {
    if (backing.kind === "on-box-vm") {
      await this.ports.backend.onBoxVmHost(backing.hostId).destroy();
      return;
    }
    if (this.ports.backend.state.container !== undefined)
      await this.ports.backend.state.container.destroy(
        new Error("Computer usage delivery unavailable"),
      );
  }
}
