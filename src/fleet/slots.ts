import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
/** Reservation facts; infrastructure capacity is supplied by the host. */
type FleetSlotReservation =
  | Readonly<{ kind: "reserved"; runningComputers: number }>
  | Readonly<{
      kind: "capacity";
      runningComputers: number;
      limit: number;
      retryAfterSeconds: number;
    }>
  | Readonly<{ kind: "unavailable"; cause: unknown }>;

/** Atomically held hosted cold starts, independent of host policy. */
export function createFleetSlots(
  options: Readonly<{
    sql: WatchdogSqliteOwner["sql"];
    transactionSync: <T>(body: () => T) => T;
  }>,
  capacity: Readonly<{ limit: number; retryAfterSeconds: number }>,
) {
  const { sql } = options;
  const ensure = () =>
    sql.exec(`CREATE TABLE IF NOT EXISTS hub_team_running_computers (
      computer_id TEXT PRIMARY KEY
    ) STRICT`);
  const count = (): number => {
    const row = sql
      .exec("SELECT COUNT(*) AS count FROM hub_team_running_computers")
      .toArray()[0];
    if (row === undefined) throw new Error("Running Computer count missing");
    return z.number().int().nonnegative().parse(row.count);
  };
  /** Capacity-only synchronous admission for a hosted cold start. */
  const reserve = (computerId: string): FleetSlotReservation => {
    try {
      return options.transactionSync(() => {
        const existing = sql
          .exec(
            "SELECT computer_id FROM hub_team_running_computers WHERE computer_id = ?",
            computerId,
          )
          .toArray()[0];
        const running = count();
        if (existing !== undefined)
          return { kind: "reserved", runningComputers: running };
        if (running >= capacity.limit)
          return {
            kind: "capacity",
            runningComputers: running,
            limit: capacity.limit,
            retryAfterSeconds: capacity.retryAfterSeconds,
          };
        sql.exec(
          "INSERT INTO hub_team_running_computers (computer_id) VALUES (?)",
          computerId,
        );
        return { kind: "reserved", runningComputers: running + 1 };
      });
    } catch (cause) {
      return { kind: "unavailable", cause };
    }
  };
  /** Releasing an absent slot is an ordinary replay from stop/sleep recovery. */
  const release = (computerId: string): void => {
    options.transactionSync(() =>
      sql.exec(
        "DELETE FROM hub_team_running_computers WHERE computer_id = ?",
        computerId,
      ),
    );
  };
  return { ensure, count, reserve, release };
}
