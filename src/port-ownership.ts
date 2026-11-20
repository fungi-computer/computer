import {
  ComputerPortConflictError,
  ComputerPortLimitError,
  ComputerPortReservedError,
  isComputerReservedPort,
  maximumExposedPorts,
} from "@fungi.computer/computer-contract";

/** The durable SQLite surface that holds a Computer's exposed ports. */
export type ExposedPortStorage = Pick<
  DurableObjectStorage,
  "sql" | "transactionSync"
>;

/**
 * Create the exposed-port table. Every owner of a port (a process or a
 * declared service) shares it, so one port has exactly one owner.
 */
export function createExposedPorts(storage: ExposedPortStorage): void {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS computer_exposed_ports (port INTEGER PRIMARY KEY CHECK (port BETWEEN 1 AND 65535), process_id TEXT) STRICT",
  );
}

/**
 * Admit one port for `owner` inside the caller's transaction. A port an owner
 * already exposed by hand (no owner) is adopted without taking it over; a port
 * another owner holds, or a daemon port, is refused; the exposure count is
 * bounded.
 */
export function claimPort(
  storage: ExposedPortStorage,
  port: number,
  owner: string,
): void {
  if (isComputerReservedPort(port)) throw new ComputerPortReservedError(port);
  const exposure = storage.sql
    .exec<{ process_id: string | null }>(
      "SELECT process_id FROM computer_exposed_ports WHERE port = ?",
      port,
    )
    .toArray()[0];
  if (exposure === undefined) {
    const ports =
      storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM computer_exposed_ports",
        )
        .toArray()[0]?.count ?? maximumExposedPorts;
    if (ports >= maximumExposedPorts) throw new ComputerPortLimitError();
    storage.sql.exec(
      "INSERT INTO computer_exposed_ports (port, process_id) VALUES (?, ?)",
      port,
      owner,
    );
    return;
  }
  if (exposure.process_id !== null && exposure.process_id !== owner)
    throw new ComputerPortConflictError();
}

/** Drop the exposures `owner` holds; a port exposed by hand is never owned. */
export function releasePortsOwnedBy(
  storage: ExposedPortStorage,
  owner: string,
): void {
  storage.sql.exec(
    "DELETE FROM computer_exposed_ports WHERE process_id = ?",
    owner,
  );
}
