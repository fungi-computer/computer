import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

/** This Computer's durable public-internet switch. Absence means on.
 * Global and Team policy still override it at the egress gateway. */
export function computerInternetAccess(
  sql: WatchdogSqliteOwner["sql"],
  enabled?: boolean,
): boolean {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS computer_internet_access (singleton INTEGER PRIMARY KEY CHECK (singleton=1), enabled INTEGER NOT NULL CHECK (enabled IN (0,1))) STRICT",
  );
  if (enabled !== undefined)
    sql.exec(
      "INSERT INTO computer_internet_access (singleton,enabled) VALUES (1,?) ON CONFLICT (singleton) DO UPDATE SET enabled=excluded.enabled",
      enabled ? 1 : 0,
    );
  const row = sql
    .exec("SELECT enabled FROM computer_internet_access WHERE singleton=1")
    .toArray()[0];
  return row === undefined
    ? true
    : z.union([z.literal(0), z.literal(1)]).parse(row.enabled) === 1;
}
