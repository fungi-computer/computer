import type {
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeExecHandle,
} from "@fungi.computer/cloudflare-computer";
import { z } from "zod";
import {
  computerProcessSchema,
  processStartInputSchema,
  mintComputerProcessId,
  ComputerProcessLimitError,
  ComputerPortReservedError,
  ComputerPortConflictError,
  ComputerPortLimitError,
  isComputerReservedPort,
  maximumExposedPorts,
  maximumProcessRecords,
  maximumRunningProcesses,
  type ComputerProcess,
  type ComputerProcessId,
  type ComputerProcessSync,
} from "@fungi.computer/computer-contract";
import { ComputerOperationConflictError } from "./operation-record.js";

/** The durable SQLite surface owned by processes and their port exposures. */
export type ComputerProcessStorage = Pick<
  DurableObjectStorage,
  "sql" | "transactionSync"
>;
type ProcessRow = {
  id: string;
  request_scope: string;
  request_id: string;
  input_hash: string;
  command: string;
  cwd: string | null;
  port: number | null;
  state: string;
  exit_code: number | null;
  sync: string;
  started_at: number;
  ended_at: number | null;
};
function toProcess(row: ProcessRow): ComputerProcess {
  return computerProcessSchema.parse({
    id: row.id,
    command: row.command,
    cwd: row.cwd,
    port: row.port,
    state: row.state,
    exitCode: row.exit_code,
    sync: row.sync,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  });
}

/**
 * Bump when `computer_processes`' columns change. Pre-release data is
 * disposable (no migrations before launch): a mismatch resets the table
 * to the fresh schema instead of a strict-table write throwing on an old
 * row shape. Tracked in a dedicated row, not `PRAGMA user_version`: that
 * pragma returns SQLITE_AUTH against a real Durable Object's SQLite
 * storage (confirmed in workerd; node:sqlite does not enforce the same
 * sandbox, so a unit test against it alone would hide this).
 */
const processSchemaVersion = 2;

/** Computer-owned replay identities; computerd owns execution and exit observations. */
export class ComputerProcessInventory {
  readonly #storage: ComputerProcessStorage;
  readonly #now: () => number;
  constructor(storage: ComputerProcessStorage, now: () => number) {
    this.#storage = storage;
    this.#now = now;
    storage.transactionSync(() => {
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS computer_schema_meta (id INTEGER PRIMARY KEY CHECK (id = 0), version INTEGER NOT NULL) STRICT",
      );
      const seenVersion =
        storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM computer_schema_meta WHERE id = 0",
          )
          .toArray()[0]?.version ?? 0;
      if (seenVersion !== processSchemaVersion) {
        storage.sql.exec("DROP TABLE IF EXISTS computer_processes");
        storage.sql.exec("DROP TABLE IF EXISTS computer_exposed_ports");
        storage.sql.exec("DELETE FROM computer_schema_meta WHERE id = 0");
        storage.sql.exec(
          "INSERT INTO computer_schema_meta (id, version) VALUES (0, ?)",
          processSchemaVersion,
        );
      }
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS computer_processes (id TEXT PRIMARY KEY, request_scope TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, port INTEGER, state TEXT NOT NULL CHECK (state IN ('running','exited')), exit_code INTEGER, sync TEXT NOT NULL DEFAULT 'unknown' CHECK (sync IN ('synced','pending','unknown')), started_at INTEGER NOT NULL, ended_at INTEGER, CHECK ((state = 'running') = (ended_at IS NULL)), UNIQUE(request_scope, request_id)) STRICT",
      );
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS computer_exposed_ports (port INTEGER PRIMARY KEY CHECK (port BETWEEN 1 AND 65535), process_id TEXT) STRICT",
      );
    });
  }
  #matching(
    input: z.output<typeof processStartInputSchema>,
    inputHash: string,
    accept?: () => void,
  ): ComputerProcess | undefined {
    const row = this.#storage.sql
      .exec<ProcessRow>(
        "SELECT * FROM computer_processes WHERE request_scope = ? AND request_id = ?",
        input.requestScope,
        input.requestId,
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    accept?.();
    if (row.input_hash !== inputHash)
      throw new ComputerOperationConflictError();
    const process = toProcess(row);
    // Admission may still be dispatching: a receipt alone does not prove liveness.
    return process.state === "running"
      ? { ...process, state: "uncertain" }
      : process;
  }
  /** A replay does not boot a backend or redispatch an exited command. */
  replay(
    input: z.output<typeof processStartInputSchema>,
    inputHash: string,
    accept: () => void,
  ): ComputerProcess | undefined {
    return this.#storage.transactionSync(() => {
      return this.#matching(input, inputHash, accept);
    });
  }
  /** Reserve the process and only a newly created exposure in one transaction. */
  admit(
    input: z.output<typeof processStartInputSchema>,
    inputHash: string,
    accept: () => void,
  ): Readonly<{ process: ComputerProcess; created: boolean }> {
    return this.#storage.transactionSync(() => {
      accept();
      const existing = this.#matching(input, inputHash);
      if (existing !== undefined) return { process: existing, created: false };
      const now = this.#now();
      const running =
        this.#storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM computer_processes WHERE state = 'running' AND request_scope = ?",
            input.requestScope,
          )
          .toArray()[0]?.count ?? maximumRunningProcesses;
      if (running >= maximumRunningProcesses)
        throw new ComputerProcessLimitError();
      const id = mintComputerProcessId();
      if (input.port !== undefined) {
        if (isComputerReservedPort(input.port))
          throw new ComputerPortReservedError(input.port);
        const exposure = this.#storage.sql
          .exec<{ process_id: string | null }>(
            "SELECT process_id FROM computer_exposed_ports WHERE port = ?",
            input.port,
          )
          .toArray()[0];
        if (exposure !== undefined && exposure.process_id !== null)
          throw new ComputerPortConflictError();
        if (exposure === undefined) {
          const ports =
            this.#storage.sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM computer_exposed_ports",
              )
              .toArray()[0]?.count ?? maximumExposedPorts;
          if (ports >= maximumExposedPorts) throw new ComputerPortLimitError();
          this.#storage.sql.exec(
            "INSERT INTO computer_exposed_ports (port, process_id) VALUES (?, ?)",
            input.port,
            id,
          );
        }
      }
      this.#storage.sql.exec(
        "INSERT INTO computer_processes (id, request_scope, request_id, input_hash, command, cwd, port, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)",
        id,
        input.requestScope,
        input.requestId,
        inputHash,
        input.command,
        input.cwd ?? null,
        input.port ?? null,
        now,
      );
      // Each scope retains its own newest 64 rows, including running processes.
      this.#storage.sql.exec(
        "DELETE FROM computer_processes WHERE request_scope = ? AND state = 'exited' AND id NOT IN (SELECT id FROM computer_processes WHERE request_scope = ? AND state = 'exited' ORDER BY started_at DESC, id DESC LIMIT MAX(0, ? - (SELECT COUNT(*) FROM computer_processes WHERE request_scope = ? AND state = 'running')))",
        input.requestScope,
        input.requestScope,
        maximumProcessRecords,
        input.requestScope,
      );
      return { process: this.#require(id), created: true };
    });
  }
  exited(
    id: ComputerProcessId,
    exitCode: number | null,
    sync: ComputerProcessSync = "unknown",
  ): ComputerProcess {
    return this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        "UPDATE computer_processes SET state = 'exited', exit_code = ?, sync = ?, ended_at = ? WHERE id = ? AND state = 'running'",
        exitCode,
        sync,
        this.#now(),
        id,
      );
      this.#storage.sql.exec(
        "DELETE FROM computer_exposed_ports WHERE process_id = ?",
        id,
      );
      return this.#require(id);
    });
  }
  /** Retain a failed dispatch receipt: retrying that key cannot create new work. */
  release(id: ComputerProcessId): void {
    const row = this.get(id);
    if (row?.state === "running") this.exited(id, null);
  }
  /**
   * Upgrade an already-exited row's sync verdict once a background drain
   * (one that gave up synchronously at its deadline) resolves it. A
   * no-op if the row was evicted or never exited: pending rows must be
   * updatable here, not only running ones.
   */
  resync(id: ComputerProcessId, sync: ComputerProcessSync): void {
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        "UPDATE computer_processes SET sync = ? WHERE id = ? AND state = 'exited'",
        sync,
        id,
      );
    });
  }
  get(id: ComputerProcessId): ComputerProcess | undefined {
    const row = this.#storage.sql
      .exec<ProcessRow>("SELECT * FROM computer_processes WHERE id = ?", id)
      .toArray()[0];
    return row === undefined ? undefined : toProcess(row);
  }
  list(): ComputerProcess[] {
    return this.#storage.sql
      .exec<ProcessRow>(
        "SELECT * FROM computer_processes ORDER BY started_at DESC, id DESC",
      )
      .toArray()
      .map(toProcess);
  }
  #require(id: ComputerProcessId): ComputerProcess {
    const found = this.get(id);
    if (found === undefined)
      throw new Error(`Computer process record is missing: ${id}`);
    return found;
  }
}

/** What one liveness observation of a computerd execution proved. */
export type ProcessObservation =
  | Readonly<{ state: "running" }>
  | Readonly<{
      state: "exited";
      exitCode: number | null;
      sync: ComputerProcessSync;
      /**
       * Present only when `sync` is "pending" because a bounded drain
       * gave up waiting: resolves once a background continuation reaches
       * the real EOF (or gives up on an error), confirming the pull
       * landed. The caller owns keeping the host alive for it (a
       * Durable Object's `waitUntil`) and applying the upgrade
       * (`ComputerProcessInventory.resync`) once it resolves.
       */
      settleLater?: Promise<ComputerProcessSync>;
    }>
  | Readonly<{ state: "uncertain" }>;

/** The part of the Workspace runtime a liveness probe uses, on one backend. */
export type ProcessRuntime = Readonly<{
  getExec: (
    id: string,
    options: { resume: "tail" | "full" },
  ) => Promise<ReadableStream<WorkspaceRuntimeEvent<"utf8">> & Disposable>;
}>;

/** How long a tail read may stay silent before the process counts as live. */
export const liveProbeMs = 750;

const lostCodeSchema = z.object({ code: z.enum(["EEXEC_LOST", "ENOENT"]) });
const busyCodeSchema = z.object({ code: z.literal("EEXEC_BUSY") });

/**
 * A replaced container runtime (the package's fence) or an execution computerd
 * no longer holds (its retention elapsed) both prove the process is gone.
 */
function lostExecution(error: Error): boolean {
  return lostCodeSchema.safeParse(error).success;
}

/** Classify a failed attach: busy is live, lost is gone, anything else is unknown. */
export function failedObservation(
  error: Error | undefined,
): ProcessObservation {
  if (error === undefined) return { state: "uncertain" };
  // computerd admits one live subscriber; the Computer's own watcher holding
  // it proves the execution is still live.
  if (busyCodeSchema.safeParse(error).success) return { state: "running" };
  return lostExecution(error)
    ? { state: "exited", exitCode: null, sync: "unknown" }
    : { state: "uncertain" };
}

async function readExitCode(runtime: ProcessRuntime, id: string) {
  using replay = await runtime.getExec(id, { resume: "full" });
  const reader = replay.getReader();
  let exitCode: number | null = null;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value.name === "exit") exitCode = next.value.code;
  }
  return exitCode;
}

/**
 * How long a drain may keep waiting for EOF once an exit has already been
 * observed, before giving up: a backgrounded child (for example
 * `node server.js &`) can hold the transport open long past its own
 * parent's exit, and nothing here may hang on that forever.
 */
export const postExitDrainDeadlineMs = 2_000;

const drainTimedOut = Symbol("computer-process-drain-timed-out");

/**
 * Keep reading past the deadline so a slow-but-real pull still lands as
 * "synced" instead of leaving the row stuck at "pending" forever; an
 * error gives up without claiming anything new. The caller already
 * handed off disposal to whoever awaits this.
 */
async function drainInBackground(
  reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent<"utf8">>,
): Promise<ComputerProcessSync> {
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return "synced";
    }
  } catch (cause) {
    console.error("Computer process background drain failed", cause);
    return "pending";
  }
}

/**
 * Keep reading `reader` past an already-observed exit, bounded: the read
 * that reaches EOF is the one that runs computerd's post-command pull
 * (the contract in computer-execution-backends.md), so the ordinary case
 * still waits for it and reports "synced". If the deadline passes
 * first, hands back a `settleLater` promise that keeps draining in the
 * background and resolves once that real EOF finally arrives -- the
 * caller must keep the reader alive for it (not dispose it) and is
 * responsible for keeping its own host alive too (a Durable Object's
 * `waitUntil`), and for applying the eventual upgrade. This is also what
 * keeps a backgrounded child holding the transport open (for example
 * `node server.js &`) from hanging the caller synchronously.
 */
async function drainPastExit(
  reader: ReadableStreamDefaultReader<WorkspaceRuntimeEvent<"utf8">>,
): Promise<
  Readonly<{
    sync: ComputerProcessSync;
    settleLater?: Promise<ComputerProcessSync>;
  }>
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof drainTimedOut>((resolve) => {
    timer = setTimeout(() => {
      resolve(drainTimedOut);
    }, postExitDrainDeadlineMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === drainTimedOut)
        return { sync: "pending", settleLater: drainInBackground(reader) };
      if (next.done) return { sync: "synced" };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Observe one execution without consuming its output: a tail attach emits
 * nothing for a live process, closes at once for an exited one, and fails
 * for one computerd no longer holds.
 */
export async function observeProcess(
  runtime: ProcessRuntime,
  id: string,
): Promise<ProcessObservation> {
  let tail: Awaited<ReturnType<ProcessRuntime["getExec"]>>;
  try {
    tail = await runtime.getExec(id, { resume: "tail" });
  } catch (error) {
    return failedObservation(error instanceof Error ? error : undefined);
  }
  const reader = tail.getReader();
  // Not a `using` disposal: the "pending" branch below hands the reader
  // to a background continuation and must not dispose it out from under
  // that continuation.
  const dispose = () => {
    reader.releaseLock();
    tail[Symbol.dispose]();
  };
  const silent = Symbol("silent");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settleLater: Promise<ComputerProcessSync> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<typeof silent>((resolve) => {
        timer = setTimeout(() => {
          resolve(silent);
        }, liveProbeMs);
      }),
    ]);
    if (first === silent) return { state: "running" };
    if (first.done) {
      try {
        return {
          state: "exited",
          exitCode: await readExitCode(runtime, id),
          sync: "unknown",
        };
      } catch (cause) {
        console.error("Computer process observation cleanup failed", cause);

        return { state: "exited", exitCode: null, sync: "unknown" };
      }
    }
    if (first.value.name === "exit") {
      // Keep draining to EOF, bounded, before reporting exited: that read
      // is the one that runs computerd's post-command Workspace pull.
      // Returning immediately disposes the reader first (the `finally`
      // below cancels it), which skips that pull instead of waiting for
      // it; waiting unboundedly can hang on a backgrounded child that
      // still holds the transport open past this execution's own exit.
      const exitCode = first.value.code;
      const drained = await drainPastExit(reader);
      settleLater = drained.settleLater;
      if (settleLater !== undefined)
        return { state: "exited", exitCode, sync: drained.sync, settleLater };
      return { state: "exited", exitCode, sync: drained.sync };
    }
    return { state: "running" };
  } catch (error) {
    return failedObservation(error instanceof Error ? error : undefined);
  } finally {
    clearTimeout(timer);
    if (settleLater === undefined) {
      await reader.cancel().catch((cause: unknown) => {
        console.error("Computer process observation cleanup failed", cause);
        return undefined;
      });
      dispose();
    } else {
      void settleLater.finally(dispose);
    }
  }
}

/**
 * Drain `run` to its exit, bounded past that exit the same way
 * `observeProcess` is, and determine whether its files reached the
 * Workspace. `undefined` if the stream broke or was replaced before any
 * exit was observed -- there is nothing to record.
 */
export async function drainProcessExit(
  run: WorkspaceRuntimeExecHandle<"utf8">,
): Promise<
  | Readonly<{
      exitCode: number;
      sync: ComputerProcessSync;
      settleLater?: Promise<ComputerProcessSync>;
    }>
  | undefined
> {
  const reader = run.getReader();
  const dispose = () => {
    reader.releaseLock();
    run[Symbol.dispose]();
  };
  let exitCode: number | undefined;
  let sync: ComputerProcessSync = "unknown";
  let settleLater: Promise<ComputerProcessSync> | undefined;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.name === "exit") {
        exitCode = next.value.code;
        const drained = await drainPastExit(reader);
        sync = drained.sync;
        settleLater = drained.settleLater;
        break;
      }
    }
  } finally {
    if (settleLater === undefined) dispose();
  }
  if (exitCode === undefined) return undefined;
  if (settleLater !== undefined)
    return { exitCode, sync, settleLater: settleLater.finally(dispose) };
  return { exitCode, sync };
}
