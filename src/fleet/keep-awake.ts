import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

/** This Computer's durable Keep awake opt-in. Absence means off: an idle
 * Computer sleeps, and only an intentional opt-in keeps it up and metered. */
export function computerKeepAwake(
  sql: WatchdogSqliteOwner["sql"],
  enabled?: boolean,
): boolean {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS computer_keep_awake (singleton INTEGER PRIMARY KEY CHECK (singleton=1), enabled INTEGER NOT NULL CHECK (enabled IN (0,1))) STRICT",
  );
  if (enabled !== undefined)
    sql.exec(
      "INSERT INTO computer_keep_awake (singleton,enabled) VALUES (1,?) ON CONFLICT (singleton) DO UPDATE SET enabled=excluded.enabled",
      enabled ? 1 : 0,
    );
  const row = sql
    .exec("SELECT enabled FROM computer_keep_awake WHERE singleton=1")
    .toArray()[0];
  return row === undefined
    ? false
    : z.union([z.literal(0), z.literal(1)]).parse(row.enabled) === 1;
}
