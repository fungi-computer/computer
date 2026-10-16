import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";
import {
  attachedBackendId,
  localBackendSchema,
  type AttachedBackend,
  type HostedBacking,
  type LocalBackend,
} from "../computer-backends.js";
import {
  ComputerBackingError,
  computerBackingChangeSchema,
  hostedBackingsSchema,
  type ComputerBackingChange,
  type ComputerBackendsProjection,
  localBackendAttachSchema,
  localBackendDetachSchema,
  localBackendDetachRequestSchema,
  type LocalBackendAttachInput,
  type LocalBackendDetachInput,
} from "./wire.js";

const maximumLocalBackends = 8;
const localRowSchema = z.lazy(() =>
  z.strictObject({
    computer_id: z.string(),
    device_id: z.string(),
    actor_id: z.string(),
    public_key: z.string(),
    host_label: z.string(),
    folder_label: z.string(),
    request_id: z.string(),
  }),
);
type LocalRow = z.output<typeof localRowSchema>;

function mintDeviceId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => alphabet.charAt(byte & 31)).join("");
}

/** Own backing records without consulting deployment configuration or a host. */
export function createFleetBacking(owner: WatchdogSqliteOwner) {
  const { sql } = owner;
  const ensure = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS computer_fleet_backends (
      scope TEXT PRIMARY KEY,
      backings TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      changed_by TEXT NOT NULL
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS computer_fleet_backing_revision (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS computer_fleet_local_backends (
      computer_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      host_label TEXT NOT NULL,
      folder_label TEXT NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      attached_at INTEGER NOT NULL,
      PRIMARY KEY (computer_id, device_id)
    ) STRICT`);
    sql.exec(`CREATE TABLE IF NOT EXISTS computer_fleet_cancelled_attaches (
      actor_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      PRIMARY KEY (actor_id, request_id)
    ) STRICT`);
  };
  const revision = (): number =>
    z
      .number()
      .int()
      .nonnegative()
      .parse(
        sql
          .exec(
            "SELECT revision FROM computer_fleet_backing_revision WHERE singleton=1",
          )
          .toArray()[0]?.revision ?? 0,
      );
  const advance = () => {
    sql.exec(
      "INSERT INTO computer_fleet_backing_revision VALUES (1,1) ON CONFLICT(singleton) DO UPDATE SET revision = revision + 1",
    );
  };
  const stored = (scope: string): HostedBacking[] | null => {
    const row = sql
      .exec(
        "SELECT backings FROM computer_fleet_backends WHERE scope = ?",
        scope,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : hostedBackingsSchema.parse(JSON.parse(z.string().parse(row.backings)));
  };
  const selectLocal =
    "SELECT computer_id, device_id, actor_id, public_key, host_label, folder_label, request_id FROM computer_fleet_local_backends";
  const localRows = (computerId: string): LocalRow[] =>
    sql
      .exec(
        `${selectLocal} WHERE computer_id = ? ORDER BY attached_at, device_id`,
        computerId,
      )
      .toArray()
      .map((row) => localRowSchema.parse(row));

  const localBackend = (row: LocalRow): LocalBackend =>
    localBackendSchema.parse({
      kind: "local",
      deviceId: row.device_id,
      publicKey: row.public_key,
      hostLabel: row.host_label,
      folderLabel: row.folder_label,
    });

  const resolve = (computerId: string): AttachedBackend[] => {
    const created = stored(`created:${computerId}`);
    if (created === null) throw new ComputerBackingError("unknown_computer");
    return [
      ...localRows(computerId).map(localBackend),
      ...(stored(`computer:${computerId}`) ?? stored("fleet") ?? created),
    ];
  };
  const projection = (computerId: string): ComputerBackendsProjection => ({
    computerId,
    revision: revision(),
    backends: resolve(computerId),
  });
  /** Creation takes a plain decision; retries cannot replace the first decision. */
  const computerCreated = (
    computerId: string,
    raw: readonly HostedBacking[],
  ): ComputerBackendsProjection => {
    const backings = hostedBackingsSchema.parse(raw);
    return owner.transactionSync(() => {
      sql.exec(
        "INSERT INTO computer_fleet_backends VALUES (?,?,?,?) ON CONFLICT(scope) DO NOTHING",
        `created:${computerId}`,
        JSON.stringify(backings),
        Date.now(),
        "computer-create",
      );
      return projection(computerId);
    });
  };
  /** The host passes the offered kinds; the fleet does not choose deployment policy. */
  const change = (
    actor: string,
    raw: ComputerBackingChange,
    config: Readonly<{
      offered: ReadonlySet<HostedBacking["kind"]>;
      computerIds: readonly string[];
    }>,
  ) => {
    const input = computerBackingChangeSchema.parse(raw);
    if (input.backings?.some((backing) => !config.offered.has(backing.kind)))
      throw new ComputerBackingError("not_enabled");
    if (input.computerId === undefined && input.backings === null)
      throw new ComputerBackingError("invalid");
    const computerIds =
      input.computerId === undefined ? config.computerIds : [input.computerId];
    return owner.transactionSync(() => {
      for (const computerId of computerIds) resolve(computerId);
      const scope =
        input.computerId === undefined
          ? "fleet"
          : `computer:${input.computerId}`;
      if (input.backings === null)
        sql.exec("DELETE FROM computer_fleet_backends WHERE scope = ?", scope);
      else
        sql.exec(
          "INSERT INTO computer_fleet_backends VALUES (?,?,?,?) ON CONFLICT(scope) DO UPDATE SET backings = excluded.backings, changed_at = excluded.changed_at, changed_by = excluded.changed_by",
          scope,
          JSON.stringify(input.backings),
          Date.now(),
          actor,
        );
      advance();
      return { revision: revision(), projections: computerIds.map(projection) };
    });
  };
  /**
   * An actor attaches a machine. Replaying the same request returns the
   * same backend; the device id is minted here, the key is the machine's.
   */
  const attachLocal = (actor: string, raw: LocalBackendAttachInput) => {
    const input = localBackendAttachSchema.parse(raw);
    if (stored(`created:${input.computerId}`) === null)
      throw new ComputerBackingError("unknown_computer");
    return owner.transactionSync(() => {
      if (
        sql
          .exec(
            "SELECT 1 FROM computer_fleet_cancelled_attaches WHERE actor_id = ? AND request_id = ?",
            actor,
            input.requestId,
          )
          .toArray().length > 0
      )
        throw new ComputerBackingError("request_conflict");
      const prior = sql
        .exec(`${selectLocal} WHERE request_id = ?`, input.requestId)
        .toArray()[0];
      if (prior !== undefined) {
        const row = localRowSchema.parse(prior);
        if (
          row.computer_id !== input.computerId ||
          row.actor_id !== actor ||
          row.public_key !== input.publicKey ||
          row.host_label !== input.hostLabel ||
          row.folder_label !== input.folderLabel
        )
          throw new ComputerBackingError("request_conflict");
        return {
          backendId: attachedBackendId(localBackend(row)),
          projections: [],
        };
      }
      if (localRows(input.computerId).length >= maximumLocalBackends)
        throw new ComputerBackingError("local_limit");
      const deviceId = mintDeviceId();
      sql.exec(
        "INSERT INTO computer_fleet_local_backends (computer_id, device_id, actor_id, public_key, host_label, folder_label, request_id, attached_at) VALUES (?,?,?,?,?,?,?,?)",
        input.computerId,
        deviceId,
        actor,
        input.publicKey,
        input.hostLabel,
        input.folderLabel,
        input.requestId,
        Date.now(),
      );
      advance();
      return {
        backendId: `local-${deviceId}`,
        projections: [projection(input.computerId)],
      };
    });
  };

  /** Which actor attached each local backend on a Computer. */
  const localOwners = (computerId: string): ReadonlyMap<string, string> =>
    new Map(
      localRows(computerId).map((row) => [
        `local-${row.device_id}`,
        row.actor_id,
      ]),
    );

  /**
   * Detach one local backend. Only the actor who attached it may; a detach
   * of one that is already gone is a no-op so an uncertain retry settles.
   */
  const detachLocal = (actor: string, raw: LocalBackendDetachInput) => {
    const input = z
      .union([localBackendDetachSchema, localBackendDetachRequestSchema])
      .parse(raw);
    if (stored(`created:${input.computerId}`) === null)
      throw new ComputerBackingError("unknown_computer");
    return owner.transactionSync(() => {
      const row =
        "requestId" in input
          ? sql
              .exec(
                `${selectLocal} WHERE computer_id = ? AND request_id = ?`,
                input.computerId,
                input.requestId,
              )
              .toArray()[0]
          : sql
              .exec(
                `${selectLocal} WHERE computer_id = ? AND device_id = ?`,
                input.computerId,
                input.backendId.slice("local-".length),
              )
              .toArray()[0];
      const attached =
        row === undefined ? undefined : localRowSchema.parse(row);
      if (attached && attached.actor_id !== actor)
        throw new ComputerBackingError("not_owner");
      const requestId = "requestId" in input ? input.requestId : undefined;
      if (requestId !== undefined) {
        const cancelled =
          sql
            .exec(
              "SELECT 1 FROM computer_fleet_cancelled_attaches WHERE actor_id = ? AND request_id = ?",
              actor,
              requestId,
            )
            .toArray().length > 0;
        if (!cancelled) {
          // Retain cancellation for the fleet lifetime: attach request IDs have no expiry.
          // The indexed per-actor ceiling bounds durable state without deleting protection.
          const count = z
            .number()
            .parse(
              sql
                .exec(
                  "SELECT count(*) AS count FROM computer_fleet_cancelled_attaches WHERE actor_id = ?",
                  actor,
                )
                .toArray()[0]?.count,
            );
          if (count >= 4096) throw new ComputerBackingError("local_limit");
          sql.exec(
            "INSERT INTO computer_fleet_cancelled_attaches VALUES (?,?)",
            actor,
            requestId,
          );
        }
      }
      if (attached === undefined) return { detached: false, projections: [] };
      sql.exec(
        "DELETE FROM computer_fleet_local_backends WHERE computer_id = ? AND device_id = ?",
        input.computerId,
        attached.device_id,
      );
      advance();
      return { detached: true, projections: [projection(input.computerId)] };
    });
  };

  /** The host withdraws an actor's devices; membership policy stays with that host. */
  const detachActorLocal = (actor: string) =>
    owner.transactionSync(() => {
      const computerIds = sql
        .exec(
          "SELECT computer_id FROM computer_fleet_local_backends WHERE actor_id = ?",
          actor,
        )
        .toArray()
        .map((row) => z.string().parse(row.computer_id));
      if (computerIds.length === 0) return { detached: 0, projections: [] };
      sql.exec(
        "DELETE FROM computer_fleet_local_backends WHERE actor_id = ?",
        actor,
      );
      advance();
      return {
        detached: computerIds.length,
        projections: [...new Set(computerIds)].map(projection),
      };
    });
  return {
    ensure,
    resolve,
    defaultBackings: () => stored("fleet"),
    hasCreationRecord: (computerId: string) =>
      stored(`created:${computerId}`) !== null,
    computerCreated,
    change,
    attachLocal,
    detachLocal,
    localOwners,
    detachActorLocal,
  };
}
