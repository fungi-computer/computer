import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { words } from "@fungi.computer/cairn";
import { defineIdFamily } from "@fungi.computer/cairn/id";
import { z } from "zod";
import {
  ComputerInventoryError,
  type FleetActor,
  type ComputerCreateRequest,
  type ComputerPage,
  computerPageSchema,
} from "./inventory-wire.js";
import type { FleetComputer } from "./inventory-wire.js";

const computerIds = defineIdFamily({
  family: "computer",
  version: 1,
  kinds: { computer: { prefix: "computer" } },
});

const rowSchema = z.strictObject({
  computer_id: z.string().min(1),
  name: z.string().min(1).max(256),
  actor_kind: z.string().min(1),
  actor_id: z.string().min(1).max(256),
  active: z.number().int().min(0).max(1),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
const receiptSchema = z.strictObject({
  requested_name: z.string().min(1).max(256).nullable(),
  request_id: z.string().min(1).max(256),
  actor_kind: z.string().min(1),
  actor_id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  computer_id: z.string().min(1),
});

const selectRow =
  "SELECT computer_id,name,actor_kind,actor_id,active,created_at,updated_at FROM hub_team_computers";

function actorColumns(actor: FleetActor) {
  return { actorId: actor.id, actorKind: actor.kind };
}

function sameActor(
  actorKind: string,
  actorId: string,
  actor: FleetActor,
): boolean {
  return actor.kind === actorKind && actor.id === actorId;
}

/** Durable Computer inventory and replay receipts, without host admission policy. */
export function createFleetInventory(
  options: Readonly<{
    sql: WatchdogSqliteOwner["sql"];
    transactionSync: <T>(body: () => T) => T;
  }>,
) {
  const { sql } = options;
  const ensure = () => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_team_computers (computer_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS hub_team_computer_create_receipts (request_id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, requested_name TEXT, name TEXT NOT NULL, computer_id TEXT NOT NULL REFERENCES hub_team_computers(computer_id)) STRICT",
    );
  };
  const decode = (row: z.output<typeof rowSchema>): FleetComputer => {
    const id = computerIds.computer.parse(row.computer_id);
    if (!id.ok) throw new ComputerInventoryError("partial_init");
    return {
      computerId: id.value,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  const nameIsTaken = (name: string): boolean =>
    sql
      .exec("SELECT computer_id FROM hub_team_computers WHERE name=?", name)
      .toArray().length > 0;
  const generatedName = (): string => {
    // Cairn's default two-word names are candidates, not registered unique IDs.
    // Add entropy on collision instead of rejecting an otherwise valid create.
    for (const count of [2, 3, 4]) {
      const candidate = words({ count });
      if (!nameIsTaken(candidate)) return candidate;
    }
    throw new ComputerInventoryError("name_taken");
  };
  const read = (computerId: string): FleetComputer | null => {
    const raw = sql
      .exec(`${selectRow} WHERE computer_id=?`, computerId)
      .toArray()[0];
    if (raw === undefined) return null;
    const row = rowSchema.safeParse(raw);
    if (!row.success) throw new ComputerInventoryError("partial_init");
    return row.data.active === 0 ? null : decode(row.data);
  };
  const count = (): number =>
    z
      .strictObject({ count: z.number().int().nonnegative() })
      .parse(
        sql
          .exec("SELECT COUNT(*) AS count FROM hub_team_computers")
          .toArray()[0],
      ).count;
  const list = (input: ComputerPage) => {
    const { limit, offset } = computerPageSchema.parse(input);
    const rows = sql
      .exec(
        `${selectRow} WHERE active=1 ORDER BY created_at DESC,computer_id DESC LIMIT ? OFFSET ?`,
        limit + 1,
        offset,
      )
      .toArray()
      .map((raw) => {
        const row = rowSchema.safeParse(raw);
        if (!row.success) throw new ComputerInventoryError("partial_init");
        return decode(row.data);
      });
    return {
      computers: rows.slice(0, limit),
      nextOffset: rows.length > limit ? offset + limit : null,
    } as const;
  };
  /** Every active Computer in this inventory. */
  const ids = (): string[] => {
    const found: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = list({ limit: 100, offset });
      found.push(...page.computers.map(({ computerId }) => computerId));
      offset = page.nextOffset;
    }
    return found;
  };

  /** Validate an existing receipt before the host decides whether a new create is funded. */
  const replay = (
    actor: FleetActor,
    request: ComputerCreateRequest,
  ): FleetComputer | null => {
    const prior = sql
      .exec(
        "SELECT request_id,actor_kind,actor_id,requested_name,name,computer_id FROM hub_team_computer_create_receipts WHERE request_id=?",
        request.requestId,
      )
      .toArray()[0];
    if (prior !== undefined) {
      const receipt = receiptSchema.safeParse(prior);
      if (!receipt.success) throw new ComputerInventoryError("partial_init");
      if (
        !sameActor(receipt.data.actor_kind, receipt.data.actor_id, actor) ||
        receipt.data.requested_name !== (request.name ?? null)
      )
        throw new ComputerInventoryError("request_conflict");
      const stored = rowSchema.safeParse(
        sql
          .exec(`${selectRow} WHERE computer_id=?`, receipt.data.computer_id)
          .toArray()[0],
      );
      if (
        !stored.success ||
        stored.data.active === 0 ||
        stored.data.name !== receipt.data.name ||
        stored.data.actor_kind !== receipt.data.actor_kind ||
        stored.data.actor_id !== receipt.data.actor_id
      )
        throw new ComputerInventoryError("partial_init");
      return decode(stored.data);
    }
    return null;
  };

  /** The host has admitted creation; identity and its receipt commit together. */
  const create = (
    actor: FleetActor,
    request: ComputerCreateRequest,
  ): FleetComputer =>
    options.transactionSync(() => {
      const prior = replay(actor, request);
      if (prior !== null) return prior;
      const name = request.name ?? generatedName();
      if (request.name !== undefined && nameIsTaken(name))
        throw new ComputerInventoryError("name_taken");
      const computerId = computerIds.computer.generate();
      const now = Date.now();
      const columns = actorColumns(actor);
      sql.exec(
        "INSERT INTO hub_team_computers (computer_id,name,actor_kind,actor_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
        computerId,
        name,
        columns.actorKind,
        columns.actorId,
        1,
        now,
        now,
      );
      sql.exec(
        "INSERT INTO hub_team_computer_create_receipts (request_id,actor_kind,actor_id,requested_name,name,computer_id) VALUES (?,?,?,?,?,?)",
        request.requestId,
        columns.actorKind,
        columns.actorId,
        request.name ?? null,
        name,
        computerId,
      );
      const created = read(computerId);
      if (created === null) throw new ComputerInventoryError("partial_init");
      return created;
    });

  return { ensure, replay, create, read, list, ids, count };
}
