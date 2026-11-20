import {
  ComputerServiceLimitError,
  ComputerServiceNotFoundError,
  computerServiceSchema,
  maximumComputerServices,
  type computerServiceDeclarationSchema,
} from "@fungi.computer/computer-contract";
import { z } from "zod";
import {
  claimPort,
  createExposedPorts,
  releasePortsOwnedBy,
  type ExposedPortStorage,
} from "./port-ownership.js";

/** A declared service as stored, the shape the contract names. */
export type ComputerService = z.output<typeof computerServiceSchema>;
/** What a person or Agent declares: name, command and optional cwd, port and env. */
export type ComputerServiceDeclaration = z.output<
  typeof computerServiceDeclarationSchema
>;
/** The JSON `fungi-services apply` reads on stdin to render the supervisor's directories. */
export type ApplyService = Pick<
  ComputerService,
  "name" | "command" | "cwd" | "env" | "enabled"
>;
export type ComputerServicesApply = Readonly<{
  services: readonly Readonly<ApplyService>[];
}>;

type ServiceRow = {
  name: string;
  command: string;
  cwd: string | null;
  port: number | null;
  env: string;
  enabled: number;
  declared_by: string;
  declared_at: number;
  revision: number;
};

const envColumn = z.record(z.string(), z.string());

function toService(row: ServiceRow): ComputerService {
  const env = envColumn.parse(JSON.parse(row.env));
  const service: z.input<typeof computerServiceSchema> = {
    name: row.name,
    command: row.command,
    enabled: row.enabled === 1,
    declaredBy: row.declared_by,
    declaredAt: row.declared_at,
    revision: row.revision,
  };
  if (row.cwd !== null) service.cwd = row.cwd;
  if (row.port !== null) service.port = row.port;
  if (Object.keys(env).length > 0) service.env = env;
  return computerServiceSchema.parse(service);
}

const ownerOf = (name: string): string => `service:${name}`;

/**
 * The Computer's declared services: the durable rules, never the live state.
 * Whether one is up is read from the supervisor on demand. A service's port is
 * admitted through the same table as a process's, so a port has one owner.
 */
export class ComputerServiceInventory {
  readonly #storage: ExposedPortStorage;
  readonly #now: () => number;
  constructor(storage: ExposedPortStorage, now: () => number) {
    this.#storage = storage;
    this.#now = now;
    storage.transactionSync(() => {
      createExposedPorts(storage);
      storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS computer_services (name TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT, port INTEGER, env TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), declared_by TEXT NOT NULL, declared_at INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1)) STRICT",
      );
    });
  }
  #row(name: string): ServiceRow | undefined {
    return this.#storage.sql
      .exec<ServiceRow>("SELECT * FROM computer_services WHERE name = ?", name)
      .toArray()[0];
  }
  /** Declare or replace one service; it is enabled, so the next apply starts it. */
  declare(
    input: ComputerServiceDeclaration,
    declaredBy: string,
  ): ComputerService {
    return this.#storage.transactionSync(() => {
      const existing = this.#row(input.name);
      if (existing === undefined) {
        const count =
          this.#storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM computer_services",
            )
            .toArray()[0]?.count ?? maximumComputerServices;
        if (count >= maximumComputerServices)
          throw new ComputerServiceLimitError();
      }
      // Only a port that moves is released: keeping it must not reset its
      // visibility or share links.
      if (existing?.port != null && existing.port !== (input.port ?? null))
        releasePortsOwnedBy(this.#storage, ownerOf(input.name));
      if (input.port !== undefined)
        claimPort(this.#storage, input.port, ownerOf(input.name));
      this.#storage.sql.exec(
        "INSERT INTO computer_services (name, command, cwd, port, env, enabled, declared_by, declared_at, revision) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1) ON CONFLICT(name) DO UPDATE SET command = excluded.command, cwd = excluded.cwd, port = excluded.port, env = excluded.env, enabled = 1, declared_by = excluded.declared_by, declared_at = excluded.declared_at, revision = revision + 1",
        input.name,
        input.command,
        input.cwd ?? null,
        input.port ?? null,
        JSON.stringify(input.env ?? {}),
        declaredBy,
        this.#now(),
      );
      return this.#require(input.name);
    });
  }
  #require(name: string): ComputerService {
    const row = this.#row(name);
    if (row === undefined) throw new ComputerServiceNotFoundError(name);
    return toService(row);
  }
  /** One service, or `undefined` when none is declared by that name. */
  get(name: string): ComputerService | undefined {
    const row = this.#row(name);
    return row === undefined ? undefined : toService(row);
  }
  /** Every declared service by name. */
  list(): readonly ComputerService[] {
    return this.#storage.sql
      .exec<ServiceRow>("SELECT * FROM computer_services ORDER BY name")
      .toArray()
      .map(toService);
  }
  /** Start or stop declaring a service as running; a stopped one stays declared. */
  setEnabled(name: string, enabled: boolean): ComputerService {
    return this.#storage.transactionSync(() => {
      this.#require(name);
      this.#storage.sql.exec(
        "UPDATE computer_services SET enabled = ? WHERE name = ?",
        enabled ? 1 : 0,
        name,
      );
      return this.#require(name);
    });
  }
  /** Remove a declaration and the port it owned. */
  remove(name: string): void {
    this.#storage.transactionSync(() => {
      this.#require(name);
      releasePortsOwnedBy(this.#storage, ownerOf(name));
      this.#storage.sql.exec(
        "DELETE FROM computer_services WHERE name = ?",
        name,
      );
    });
  }
  /**
   * Re-admit every declared service port. The process inventory rebuilds the
   * exposure table when its own schema changes; the declarations outlive that.
   */
  ensurePorts(): void {
    this.#storage.transactionSync(() => {
      for (const service of this.list())
        if (service.port !== undefined)
          claimPort(this.#storage, service.port, ownerOf(service.name));
    });
  }
  /** What `fungi-services apply` renders: every declaration and whether it runs. */
  applyPayload(): ComputerServicesApply {
    const services = this.list().map(({ name, command, cwd, env, enabled }) => {
      const entry: ApplyService = { name, command, enabled };
      if (cwd !== undefined) entry.cwd = cwd;
      if (env !== undefined) entry.env = env;
      return entry;
    });
    return { services };
  }
}
