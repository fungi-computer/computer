import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ComputerProcessInventory } from "../dist/process-inventory.js";
import { ComputerServiceInventory } from "../dist/services.js";
import {
  applyDeclaredServices,
  ComputerServicesApplyError,
  servicesApplyCommand,
} from "../dist/services-apply.js";

function sqliteStorage() {
  const database = new DatabaseSync(":memory:");
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

const done = { status: "completed", exitCode: 0, stderr: "" };

test("a runtime start applies every declaration, enabled or stopped, in one command", async () => {
  const storage = sqliteStorage();
  const services = new ComputerServiceInventory(storage, () => 1);
  services.declare(
    { name: "web", command: "node server.js", port: 3000 },
    "owner:a",
  );
  services.declare(
    { name: "worker", command: "printf '$HOME `id`\n'", env: { Q: "it's" } },
    "owner:a",
  );
  services.setEnabled("worker", false);
  const commands = [];
  assert.equal(
    await applyDeclaredServices({
      inventory: services,
      run: (command) => {
        commands.push(command);
        return Promise.resolve(done);
      },
    }),
    "applied",
  );
  assert.equal(commands.length, 1);
  // The command carries the payload as inert text: running it prints the JSON back.
  const echoed = commands[0].replace("| fungi-services apply", "| cat");
  assert.deepEqual(
    JSON.parse(execFileSync("/bin/sh", ["-c", echoed], { encoding: "utf8" })),
    services.applyPayload(),
  );
  assert.deepEqual(
    JSON.parse(
      execFileSync("/bin/sh", ["-c", echoed], { encoding: "utf8" }),
    ).services.map(({ name, enabled }) => [name, enabled]),
    [
      ["web", true],
      ["worker", false],
    ],
  );
  // Nothing in the command line is shell syntax but the pipeline itself.
  assert.match(
    commands[0],
    /^printf %s '[A-Za-z0-9+/=]+' \| base64 -d \| fungi-services apply$/u,
  );
});

test("nothing declared runs nothing: a new runtime's scan directory is already empty", async () => {
  const services = new ComputerServiceInventory(sqliteStorage(), () => 1);
  let ran = 0;
  assert.equal(
    await applyDeclaredServices({
      inventory: services,
      run: () => {
        ran += 1;
        return Promise.resolve(done);
      },
    }),
    "none",
  );
  assert.equal(ran, 0);
});

test("a failed apply is a typed error carrying the command's own reason", async () => {
  const services = new ComputerServiceInventory(sqliteStorage(), () => 1);
  services.declare({ name: "web", command: "true" }, "owner:a");
  for (const result of [
    { status: "completed", exitCode: 1, stderr: "s6-svscanctl: not running" },
    { status: "timeout", exitCode: null, stderr: "" },
  ])
    await assert.rejects(
      applyDeclaredServices({
        inventory: services,
        run: () => Promise.resolve(result),
      }),
      (error) =>
        error instanceof ComputerServicesApplyError &&
        error.message.includes(result.status) &&
        error.message.includes(result.stderr),
    );
});

test("the command carries non-ASCII declarations as inert base64", () => {
  const command = servicesApplyCommand({
    services: [{ name: "web", command: "echo 'héllo' $(x)", enabled: true }],
  });
  const echoed = command.replace("| fungi-services apply", "| cat");
  assert.equal(
    JSON.parse(execFileSync("/bin/sh", ["-c", echoed], { encoding: "utf8" }))
      .services[0].command,
    "echo 'héllo' $(x)",
  );
});

test("service ports are re-admitted before the command runs", async () => {
  const storage = sqliteStorage();
  new ComputerProcessInventory(storage, () => 1);
  const services = new ComputerServiceInventory(storage, () => 1);
  services.declare({ name: "web", command: "true", port: 3000 }, "owner:a");
  storage.database.exec("DELETE FROM computer_exposed_ports");
  await applyDeclaredServices({
    inventory: services,
    run: () => {
      const owner = storage.database
        .prepare(
          "SELECT process_id FROM computer_exposed_ports WHERE port = 3000",
        )
        .get()?.process_id;
      assert.equal(owner, "service:web");
      return Promise.resolve(done);
    },
  });
});
