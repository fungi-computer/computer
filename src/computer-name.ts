import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

/*
 * A Computer's durable name, recorded by each name-addressed wake.
 *
 * `ctx.id.name` belongs to the wake that constructed the live instance, not to
 * the object. The doors that address a Computer by object id (the container's
 * WorkspaceProxy reconnect and egress, the service proxy, VM ingress) and
 * alarms wake it with no name, and every later name-addressed call reaches
 * that same nameless instance. A redeploy restarts the object while its
 * container reconnects, so a nameless instance reads the name from storage.
 */

/** Record the name a name-addressed wake carries. */
export function recordComputerName(
  sql: WatchdogSqliteOwner["sql"],
  name: string,
): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS computer_name (singleton INTEGER PRIMARY KEY CHECK (singleton=1), name TEXT NOT NULL) STRICT",
  );
  sql.exec(
    "INSERT INTO computer_name (singleton,name) VALUES (1,?) ON CONFLICT (singleton) DO NOTHING",
    name,
  );
  // An object id is derived from its name, so a second name is corruption.
  if (storedComputerName(sql) !== name)
    throw new Error("Computer storage records a different name");
}

/**
 * The wake's own name, else the recorded one. Read-only: it never recreates
 * the record after an erasure. Undefined only when no name-addressed wake has
 * reached this Computer.
 */
export function computerName(
  sql: WatchdogSqliteOwner["sql"],
  wokenAs: string | undefined,
): string | undefined {
  return wokenAs ?? storedComputerName(sql);
}

function storedComputerName(
  sql: WatchdogSqliteOwner["sql"],
): string | undefined {
  const recorded =
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='computer_name'",
      )
      .toArray().length > 0;
  if (!recorded) return undefined;
  const row = sql
    .exec("SELECT name FROM computer_name WHERE singleton=1")
    .toArray()[0];
  return row === undefined ? undefined : z.string().parse(row.name);
}
