import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ComputerPortConflictError,
  ComputerPortLimitError,
  ComputerPortReservedError,
  ComputerServiceLimitError,
  ComputerServiceNotFoundError,
  maximumComputerServices,
  maximumExposedPorts,
} from "@fungi.computer/computer-contract";
import { ComputerProcessInventory } from "../dist/process-inventory.js";
import { ComputerServiceInventory } from "../dist/services.js";

/** The Durable Object SQL surface, backed by a real SQLite database. */
function sqliteStorage(database = new DatabaseSync(":memory:")) {
  return {
    database,
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const rows =
          statement.columns().length > 0
            ? statement.all(...bindings)
            : (statement.run(...bindings), []);
        return { toArray: () => rows.map((row) => ({ ...row })) };
      },
    },
    transactionSync(operation) {
      database.exec("SAVEPOINT operation");
      try {
        const result = operation();
        database.exec("RELEASE operation");
        return result;
      } catch (error) {
        database.exec("ROLLBACK TO operation");
        database.exec("RELEASE operation");
        throw error;
      }
    },
  };
}

let clock = 1_800_000_000_000;
const now = () => (clock += 1_000);
const web = { name: "web", command: "node server.js" };
const startProcess = (inventory, port, requestId = "r1") =>
  inventory.admit(
    "container",
    { requestScope: "tool:agent:a", requestId, command: "serve", port },
    `hash-${requestId}`,
    () => undefined,
  );
const owner = (storage, port) =>
  storage.sql
    .exec("SELECT process_id FROM computer_exposed_ports WHERE port = ?", port)
    .toArray()[0]?.process_id;

test("declaring a service stores it enabled and a redeclaration replaces it", () => {
  const services = new ComputerServiceInventory(sqliteStorage(), now);
  const first = services.declare(web, "owner:member-a");
  assert.deepEqual(first, {
    ...web,
    enabled: true,
    declaredBy: "owner:member-a",
    declaredAt: first.declaredAt,
    revision: 1,
  });
  const second = services.declare(
    { ...web, command: "node other.js", env: { MODE: "x" } },
    "agent:agent-a",
  );
  assert.equal(second.revision, 2);
  assert.equal(second.command, "node other.js");
  assert.deepEqual(second.env, { MODE: "x" });
  assert.equal(second.declaredBy, "agent:agent-a");
  assert.ok(second.declaredAt > first.declaredAt);
  assert.deepEqual(services.list(), [second]);
  assert.deepEqual(services.get("web"), second);
  // A stopped service stays declared; redeclaring it does not start it again by itself.
  assert.equal(services.setEnabled("web", false).enabled, false);
  assert.equal(services.setEnabled("web", false).revision, second.revision);
  assert.equal(services.declare(web, "owner:member-a").enabled, true);
});

test("a Computer declares at most sixteen services, and a redeclaration is not a new one", () => {
  const services = new ComputerServiceInventory(sqliteStorage(), now);
  for (let index = 0; index < maximumComputerServices; index += 1)
    services.declare({ ...web, name: `s${String(index)}` }, "owner:a");
  assert.throws(
    () => services.declare({ ...web, name: "extra" }, "owner:a"),
    ComputerServiceLimitError,
  );
  assert.equal(services.declare({ ...web, name: "s0" }, "owner:a").revision, 2);
  assert.equal(services.list().length, maximumComputerServices);
  assert.deepEqual(
    services.list().map((service) => service.name),
    services
      .list()
      .map((service) => service.name)
      .toSorted(),
  );
});

test("unknown services are typed, not silently created", () => {
  const services = new ComputerServiceInventory(sqliteStorage(), now);
  for (const act of [
    () => services.setEnabled("missing", true),
    () => services.remove("missing"),
  ])
    assert.throws(act, ComputerServiceNotFoundError);
  assert.equal(services.get("missing"), undefined);
});

test("a service port has one owner across services and processes", () => {
  const storage = sqliteStorage();
  const processes = new ComputerProcessInventory(storage, now);
  const services = new ComputerServiceInventory(storage, now);
  services.declare({ ...web, port: 3000 }, "owner:a");
  assert.equal(owner(storage, 3000), "service:web");
  // A process cannot take a service's port, and a second service cannot either.
  assert.throws(() => startProcess(processes, 3000), ComputerPortConflictError);
  assert.throws(
    () => services.declare({ ...web, name: "api", port: 3000 }, "owner:a"),
    ComputerPortConflictError,
  );
  // The reverse: a running process's port is not available to a service.
  startProcess(processes, 4000, "r2");
  assert.throws(
    () => services.declare({ ...web, name: "api", port: 4000 }, "owner:a"),
    ComputerPortConflictError,
  );
  // Daemon ports are never admitted.
  for (const port of [8080, 7681])
    assert.throws(
      () => services.declare({ ...web, name: "api", port }, "owner:a"),
      ComputerPortReservedError,
    );
  // The failed declarations left nothing behind.
  assert.deepEqual(
    services.list().map((service) => service.name),
    ["web"],
  );
});

test("changing, stopping and removing a service releases or keeps its port as declared", () => {
  const storage = sqliteStorage();
  const services = new ComputerServiceInventory(storage, now);
  services.declare({ ...web, port: 3000 }, "owner:a");
  services.declare({ ...web, port: 3001 }, "owner:a");
  assert.equal(owner(storage, 3000), undefined);
  assert.equal(owner(storage, 3001), "service:web");
  // Stopped is still declared: the port stays reserved for its next start.
  services.setEnabled("web", false);
  assert.equal(owner(storage, 3001), "service:web");
  services.declare({ name: "web", command: "node server.js" }, "owner:a");
  assert.equal(owner(storage, 3001), undefined);
  services.declare({ ...web, port: 3002 }, "owner:a");
  services.remove("web");
  assert.equal(owner(storage, 3002), undefined);
  assert.deepEqual(services.list(), []);
});

test("a port the owner already exposed is adopted without taking over its exposure", () => {
  const storage = sqliteStorage();
  const services = new ComputerServiceInventory(storage, now);
  storage.sql.exec(
    "INSERT INTO computer_exposed_ports (port, process_id) VALUES (5000, NULL)",
  );
  services.declare({ ...web, port: 5000 }, "owner:a");
  assert.equal(owner(storage, 5000), null);
  services.remove("web");
  assert.equal(owner(storage, 5000), null);
});

test("service ports count against the exposed-port limit", () => {
  const storage = sqliteStorage();
  const services = new ComputerServiceInventory(storage, now);
  for (let port = 9000; port < 9000 + maximumExposedPorts; port += 1)
    storage.sql.exec(
      "INSERT INTO computer_exposed_ports (port, process_id) VALUES (?, NULL)",
      port,
    );
  assert.throws(
    () => services.declare({ ...web, port: 20_000 }, "owner:a"),
    ComputerPortLimitError,
  );
  assert.equal(services.get("web"), undefined);
});

test("opening the services on a store from before they existed keeps its processes and ports", () => {
  const database = new DatabaseSync(":memory:");
  const before = sqliteStorage(database);
  const processes = new ComputerProcessInventory(before, now);
  startProcess(processes, 4000);
  assert.equal(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'computer_services'",
      )
      .all().length,
    0,
  );
  const services = new ComputerServiceInventory(sqliteStorage(database), now);
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM computer_processes").get().n,
    1,
  );
  assert.equal(owner(before, 4000) !== undefined, true);
  services.declare({ ...web, port: 3000 }, "owner:a");
  // Reopening is idempotent and keeps the declarations.
  const reopened = new ComputerServiceInventory(sqliteStorage(database), now);
  assert.equal(reopened.get("web")?.port, 3000);
  assert.equal(reopened.list().length, 1);
});

test("service ports are reasserted after the process inventory resets the exposures", () => {
  const database = new DatabaseSync(":memory:");
  const storage = sqliteStorage(database);
  new ComputerProcessInventory(storage, now);
  const services = new ComputerServiceInventory(storage, now);
  services.declare({ ...web, port: 3000 }, "owner:a");
  services.declare({ name: "worker", command: "node w.js" }, "owner:a");
  database.exec("DELETE FROM computer_exposed_ports");
  assert.equal(owner(storage, 3000), undefined);
  services.ensurePorts();
  assert.equal(owner(storage, 3000), "service:web");
  services.ensurePorts();
  assert.equal(
    database.prepare("SELECT COUNT(*) AS n FROM computer_exposed_ports").get()
      .n,
    1,
  );
});

test("the apply payload carries each declaration and whether it runs", () => {
  const services = new ComputerServiceInventory(sqliteStorage(), now);
  services.declare(
    { ...web, cwd: "/workspace/app", port: 3000, env: { A: "1" } },
    "owner:a",
  );
  services.declare({ name: "worker", command: "node w.js" }, "owner:a");
  services.setEnabled("worker", false);
  assert.deepEqual(services.applyPayload(), {
    services: [
      {
        name: "web",
        command: "node server.js",
        cwd: "/workspace/app",
        env: { A: "1" },
        enabled: true,
      },
      { name: "worker", command: "node w.js", enabled: false },
    ],
  });
});
