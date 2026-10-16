import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  hostedBackingSchema,
  type ContainerRuntimeStart,
  type HostedBacking,
} from "../computer-backends.js";
import type {
  ComputerFact,
  ComputerProvenance,
  ComputerUsageInterval,
} from "./wire.js";

/**
 * Computer-local interval ledger; the host owns usage settlement.
 *
 * A running runtime's checkpoint advances at most once per `checkpointMs`.
 * Repeated reads inside one checkpoint expose the same interval so the host
 * can deliver it idempotently.
 */
export class ComputerRuntimeUsage {
  constructor(
    private readonly sql: WatchdogSqliteOwner["sql"],
    private readonly checkpointMs: number,
  ) {}

  ensure(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_computer_runtime_usage (runtime_id TEXT PRIMARY KEY, backing TEXT NOT NULL, started_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, ended INTEGER NOT NULL CHECK (ended IN (0,1)), delivered_at INTEGER NOT NULL DEFAULT -1) STRICT",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_computer_runtime_activity (runtime_id TEXT PRIMARY KEY, last_activity_at INTEGER NOT NULL) STRICT",
    );
  }

  started(start: ContainerRuntimeStart): void {
    this.ensure();
    this.sql.exec(
      "INSERT OR IGNORE INTO hub_computer_runtime_usage (runtime_id, backing, started_at, observed_at, ended) VALUES (?,?,?,?,0)",
      start.runtimeId,
      JSON.stringify(start.backing),
      start.startedAt,
      start.startedAt,
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO hub_computer_runtime_activity (runtime_id, last_activity_at) VALUES (?,?)",
      start.runtimeId,
      start.startedAt,
    );
  }

  touchActivity(backing: HostedBacking, at: number): void {
    this.ensure();
    const encodedBacking = JSON.stringify(backing);
    this.sql.exec(
      "UPDATE hub_computer_runtime_activity SET last_activity_at=MAX(last_activity_at, ?) WHERE runtime_id IN (SELECT runtime_id FROM hub_computer_runtime_usage WHERE backing=? AND ended=0)",
      at,
      encodedBacking,
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO hub_computer_runtime_activity (runtime_id, last_activity_at) SELECT runtime_id, ? FROM hub_computer_runtime_usage WHERE backing=? AND ended=0",
      at,
      encodedBacking,
    );
  }

  idleDeadline(runtimeId: string, idleMs: number, now: number): number | null {
    this.ensure();
    this.sql.exec(
      "INSERT OR IGNORE INTO hub_computer_runtime_activity (runtime_id, last_activity_at) SELECT runtime_id, ? FROM hub_computer_runtime_usage WHERE runtime_id=? AND ended=0",
      now,
      runtimeId,
    );
    const row = this.sql
      .exec(
        "SELECT last_activity_at FROM hub_computer_runtime_activity WHERE runtime_id=?",
        runtimeId,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : z.number().int().nonnegative().parse(row.last_activity_at) + idleMs;
  }

  hasOpen(backing: HostedBacking): boolean {
    this.ensure();
    return (
      this.sql
        .exec(
          "SELECT runtime_id FROM hub_computer_runtime_usage WHERE ended=0 AND backing=? LIMIT 1",
          JSON.stringify(backing),
        )
        .toArray().length > 0
    );
  }

  hasAnyOpen(): boolean {
    return (
      this.sql
        .exec(
          "SELECT runtime_id FROM hub_computer_runtime_usage WHERE ended=0 LIMIT 1",
        )
        .toArray().length > 0
    );
  }

  open(): { runtimeId: string; backing: HostedBacking }[] {
    return this.sql
      .exec(
        "SELECT runtime_id, backing FROM hub_computer_runtime_usage WHERE ended = 0 ORDER BY started_at DESC",
      )
      .toArray()
      .map((row) => ({
        runtimeId: z.string().parse(row.runtime_id),
        backing: hostedBackingSchema.parse(
          JSON.parse(z.string().parse(row.backing)),
        ),
      }));
  }

  recycleCandidates(before: number): {
    runtimeId: string;
    backing: HostedBacking;
  }[] {
    return this.sql
      .exec(
        "SELECT runtime_id,backing FROM hub_computer_runtime_usage WHERE ended=0 AND started_at<=?",
        before,
      )
      .toArray()
      .map((row) => ({
        runtimeId: z.string().parse(row.runtime_id),
        backing: hostedBackingSchema.parse(
          JSON.parse(z.string().parse(row.backing)),
        ),
      }));
  }

  private ensureRecycle(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_computer_vm_recycle (runtime_id TEXT PRIMARY KEY, backing TEXT NOT NULL, requested_at INTEGER NOT NULL) STRICT",
    );
  }

  pendingRecycles(): {
    runtimeId: string;
    backing: Extract<HostedBacking, { kind: "on-box-vm" }>;
    requestedAt: number;
  }[] {
    this.ensureRecycle();
    return this.sql
      .exec(
        "SELECT runtime_id,backing,requested_at FROM hub_computer_vm_recycle",
      )
      .toArray()
      .map((row) => {
        const backing = hostedBackingSchema.parse(
          JSON.parse(z.string().parse(row.backing)),
        );
        if (backing.kind !== "on-box-vm")
          throw new Error("Invalid VM recycle backing");
        return {
          runtimeId: z.string().parse(row.runtime_id),
          backing,
          requestedAt: z.number().parse(row.requested_at),
        };
      });
  }

  requestRecycle(
    runtimeId: string,
    backing: HostedBacking,
    requestedAt: number,
  ): void {
    this.ensureRecycle();
    this.sql.exec(
      "INSERT INTO hub_computer_vm_recycle (runtime_id,backing,requested_at) VALUES (?,?,?)",
      runtimeId,
      JSON.stringify(backing),
      requestedAt,
    );
  }

  finishRecycle(runtimeId: string): void {
    this.sql.exec(
      "DELETE FROM hub_computer_vm_recycle WHERE runtime_id=?",
      runtimeId,
    );
  }

  oldestVmStart(): number | null {
    return z
      .number()
      .nullable()
      .parse(
        this.sql
          .exec(
            "SELECT MIN(started_at) AS started_at FROM hub_computer_runtime_usage WHERE ended=0 AND json_extract(backing,'$.kind')='on-box-vm'",
          )
          .toArray()[0]?.started_at ?? null,
      );
  }

  observe(
    runtimeId: string,
    observed: { running: boolean; endedAt: number },
  ): void {
    if (!observed.running) {
      this.sql.exec(
        "UPDATE hub_computer_runtime_usage SET observed_at = MAX(observed_at, ?), ended = 1 WHERE runtime_id = ?",
        observed.endedAt,
        runtimeId,
      );
      return;
    }
    const now = Date.now();
    this.sql.exec(
      "UPDATE hub_computer_runtime_usage SET observed_at = ? WHERE runtime_id = ? AND ended = 0 AND observed_at <= ?",
      now,
      runtimeId,
      now - this.checkpointMs,
    );
  }

  pending(): ComputerUsageInterval[] {
    return this.sql
      .exec(
        "SELECT runtime_id, backing, started_at, observed_at, ended FROM hub_computer_runtime_usage WHERE observed_at > delivered_at OR ended = 1 LIMIT 64",
      )
      .toArray()
      .map((row) => ({
        runtimeId: z.string().parse(row.runtime_id),
        backing: hostedBackingSchema.parse(
          JSON.parse(z.string().parse(row.backing)),
        ),
        startedAt: z.number().parse(row.started_at),
        observedAt: z.number().parse(row.observed_at),
        ended: row.ended === 1,
      }));
  }

  /** Read delivery facts without changing the retained checkpoint or acknowledgment. */
  pendingFacts(
    computerId: string,
    provenance: ComputerProvenance,
  ): Extract<ComputerFact, { kind: "interval" }>[] {
    return this.pending().map((interval) => ({
      kind: "interval",
      computerId,
      provenance,
      ...interval,
    }));
  }

  acknowledge(intervals: readonly ComputerUsageInterval[]): void {
    for (const interval of intervals)
      this.sql.exec(
        "UPDATE hub_computer_runtime_usage SET delivered_at = ? WHERE runtime_id = ?",
        interval.observedAt,
        interval.runtimeId,
      );
    // Ended and delivered intervals live on in the host's settlement ledger only.
    for (const interval of intervals)
      if (interval.ended)
        this.sql.exec(
          "DELETE FROM hub_computer_runtime_usage WHERE runtime_id = ? AND ended = 1 AND delivered_at >= observed_at",
          interval.runtimeId,
        );
    for (const interval of intervals)
      if (interval.ended)
        this.sql.exec(
          "DELETE FROM hub_computer_runtime_activity WHERE runtime_id=? AND NOT EXISTS (SELECT 1 FROM hub_computer_runtime_usage WHERE runtime_id=?)",
          interval.runtimeId,
          interval.runtimeId,
        );
  }
}
