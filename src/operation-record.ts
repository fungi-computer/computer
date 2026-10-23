import {
  computerOperationResultSchema,
  computerRequestIdSchema,
  execOutputSchema,
  type ComputerExecOutput,
  type ComputerOperationResult,
  type ComputerRequestId,
} from "@fungi.computer/computer-contract";

/** Terminal status records are retained for 7 days. */
export const operationRetentionMs = 7 * 24 * 60 * 60 * 1_000;
/** Command output may contain secrets, so it is cleared after 24 hours. */
export const operationOutputRetentionMs = 24 * 60 * 60 * 1_000;
/** At most this many status records are stored per Computer. */
export const maximumOperationRecords = 500;
/**
 * A request ID is admitted as new work only when its UUIDv7 time is within this
 * distance of the owner's clock. Records stay protected from capacity eviction
 * until both their acceptance time and their ID time are older than the window,
 * so a missing in-window ID was never admitted and an out-of-window ID expires.
 */
export const operationAdmissionWindowMs = 5 * 60 * 1_000;

export class ComputerOperationConflictError extends Error {
  constructor() {
    super("Computer request ID is already bound to another operation");
    this.name = "ComputerOperationConflictError";
  }
}

export class ComputerOperationLimitError extends Error {
  constructor() {
    super(
      "Computer operation record capacity is occupied by recent or active work",
    );
    this.name = "ComputerOperationLimitError";
  }
}

export class ComputerRequestInvalidError extends Error {
  constructor() {
    super("Computer request ID is outside the allowed clock-skew window");
    this.name = "ComputerRequestInvalidError";
  }
}

/** The Durable Object storage surface this record owns. */
export type ComputerOperationStorage = Pick<
  DurableObjectStorage,
  "sql" | "transactionSync"
>;

type OperationRow = {
  request_id: string;
  input_hash: string;
  status: string;
  created_at: number;
  output_expires_at: number;
  output_json: string | null;
};

/** The embedded UUIDv7 millisecond time; the ID is already Zod-validated. */
function requestIdTime(requestId: ComputerRequestId): number {
  return Number.parseInt(requestId.replaceAll("-", "").slice(0, 12), 16);
}

/**
 * Durable `exec`/`bash` operation outcomes for one Computer. Every retention,
 * eviction and expiry decision uses the owner's clock; a caller's UUIDv7 time
 * only selects whether an unseen ID is inside the admission window.
 */
export class ComputerOperationRecord {
  readonly #storage: ComputerOperationStorage;
  readonly #now: () => number;

  constructor(storage: ComputerOperationStorage, now: () => number) {
    this.#storage = storage;
    this.#now = now;
    const sql = storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS computer_operations (request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'succeeded', 'failed', 'unknown')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, output_expires_at INTEGER NOT NULL, output_json TEXT) STRICT",
    );
    // Reopening never reinterprets unfinished work as permission to rerun it.
    storage.transactionSync(() => {
      sql.exec(
        "UPDATE computer_operations SET status = 'unknown', updated_at = ? WHERE status IN ('accepted', 'running')",
        now(),
      );
    });
  }

  #admissionTime(requestIdInput: string) {
    const requestId = computerRequestIdSchema.parse(requestIdInput);
    const requestTime = requestIdTime(requestId);
    const now = this.#now();
    if (requestTime > now + operationAdmissionWindowMs) {
      throw new ComputerRequestInvalidError();
    }
    return { requestId, requestTime, now };
  }

  /**
   * Atomically return the recorded state of a known ID, or admit a new one as
   * `accepted`. `undefined` means the caller now owns dispatching it once.
   */
  admit(
    requestIdInput: string,
    inputHash: string,
    accept: () => void,
  ): ComputerOperationResult | undefined {
    const { requestId, requestTime, now } = this.#admissionTime(requestIdInput);
    return this.#storage.transactionSync(() => {
      accept();
      this.#sweep(now);
      const existing = this.#row(requestId);
      if (existing !== undefined) {
        if (existing.input_hash !== inputHash)
          throw new ComputerOperationConflictError();
        return this.#result(requestId, existing, now);
      }
      if (requestTime < now - operationAdmissionWindowMs) {
        return this.#result(requestId, undefined, now);
      }
      this.#makeRoom(now);
      this.#storage.sql.exec(
        "INSERT INTO computer_operations (request_id, input_hash, status, created_at, updated_at, output_expires_at, output_json) VALUES (?, ?, 'accepted', ?, ?, ?, NULL)",
        requestId,
        inputHash,
        now,
        now,
        now + operationOutputRetentionMs,
      );
      return undefined;
    });
  }

  /** Record entry into the Workspace command. */
  markRunning(requestId: ComputerRequestId): void {
    this.#storage.sql.exec(
      "UPDATE computer_operations SET status = 'running', updated_at = ? WHERE request_id = ?",
      this.#now(),
      requestId,
    );
  }

  /** Record the one terminal command result. */
  settle(requestId: ComputerRequestId, output: ComputerExecOutput): void {
    const finishedAt = this.#now();
    this.#storage.sql.exec(
      "UPDATE computer_operations SET status = ?, updated_at = ?, output_expires_at = ?, output_json = ? WHERE request_id = ?",
      output.status === "completed" ? "succeeded" : "failed",
      finishedAt,
      finishedAt + operationOutputRetentionMs,
      JSON.stringify(execOutputSchema.parse(output)),
      requestId,
    );
  }

  /**
   * The command may have started, but no terminal result is established. The
   * cause is logged so capacity or start failures stay diagnosable.
   */
  settleUnknown(requestId: ComputerRequestId, cause: string): void {
    console.error("Computer operation outcome unknown", { requestId, cause });
    this.#storage.sql.exec(
      "UPDATE computer_operations SET status = 'unknown', updated_at = ?, output_json = NULL WHERE request_id = ?",
      this.#now(),
      requestId,
    );
  }

  /** Durable status lookup; an unseen ID older than the window is expired. */
  status(requestIdInput: string, accept: () => void): ComputerOperationResult {
    const { requestId, now } = this.#admissionTime(requestIdInput);
    return this.#storage.transactionSync(() => {
      accept();
      this.#sweep(now);
      return this.#result(requestId, this.#row(requestId), now);
    });
  }

  #row(requestId: ComputerRequestId): OperationRow | undefined {
    return this.#storage.sql
      .exec<OperationRow>(
        "SELECT request_id, input_hash, status, created_at, output_expires_at, output_json FROM computer_operations WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
  }

  #result(
    requestId: ComputerRequestId,
    row: OperationRow | undefined,
    now: number,
  ): ComputerOperationResult {
    if (row !== undefined) {
      return computerOperationResultSchema.parse({
        requestId,
        status: row.status,
        output:
          row.output_json !== null && row.output_expires_at > now
            ? execOutputSchema.parse(JSON.parse(row.output_json))
            : null,
      });
    }
    return computerOperationResultSchema.parse({
      requestId,
      status:
        requestIdTime(requestId) < now - operationAdmissionWindowMs
          ? "expired"
          : "unknown",
      output: null,
    });
  }

  #sweep(now: number): void {
    const sql = this.#storage.sql;
    sql.exec(
      "UPDATE computer_operations SET output_json = NULL WHERE output_json IS NOT NULL AND output_expires_at <= ?",
      now,
    );
    // Admission bounds an ID's time to its acceptance time plus the window, so
    // a record accepted 7 days ago is always outside the admission window.
    sql.exec(
      "DELETE FROM computer_operations WHERE status IN ('succeeded', 'failed', 'unknown') AND created_at <= ?",
      now - operationRetentionMs,
    );
  }

  /** Evict the oldest terminal record that no in-window retry can address. */
  #makeRoom(now: number): void {
    const sql = this.#storage.sql;
    const count = sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM computer_operations",
      )
      .toArray()[0]?.count;
    if (count === undefined) throw new ComputerOperationLimitError();
    if (count < maximumOperationRecords) return;
    const horizon = now - operationAdmissionWindowMs;
    const evictable = sql
      .exec<{ request_id: string }>(
        "SELECT request_id FROM computer_operations WHERE status IN ('succeeded', 'failed', 'unknown') AND created_at < ? ORDER BY created_at ASC, request_id ASC",
        horizon,
      )
      .toArray()
      .find(({ request_id }) => requestIdTime(request_id) < horizon);
    if (evictable === undefined) throw new ComputerOperationLimitError();
    sql.exec(
      "DELETE FROM computer_operations WHERE request_id = ?",
      evictable.request_id,
    );
  }
}
