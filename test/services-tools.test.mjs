import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ComputerPortConflictError,
  ComputerServiceNotFoundError,
  computerServiceViewSchema,
  serviceListOutputSchema,
} from "@fungi.computer/computer-contract";
import { ComputerServiceInventory } from "../dist/services.js";
import { ComputerServicesApplyError } from "../dist/services-apply.js";
import {
  declareService,
  listServices,
  removeService,
  restartService,
  serviceLogs,
  setServiceEnabled,
} from "../dist/services-tools.js";

function sqliteStorage() {
  const database = new DatabaseSync(":memory:");
  return {
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

/** A fake Computer: awake or asleep, with the commands it was asked to run. */
function fixture({ awake = true, live = {} } = {}) {
  const inventory = new ComputerServiceInventory(sqliteStorage(), () => 5);
  const commands = [];
  const state = { awake, live, fail: null, logs: ["one", "two"] };
  const runtime = {
    awake: () => Promise.resolve(state.awake),
    run: (command) => {
      commands.push(command);
      if (state.fail !== null) return Promise.resolve(state.fail);
      const ok = (stdout) =>
        Promise.resolve({
          status: "completed",
          exitCode: 0,
          stdout,
          stderr: "",
        });
      if (command.startsWith("fungi-services status"))
        return ok(JSON.stringify({ services: state.live }));
      if (command.startsWith("fungi-services logs"))
        return ok(
          JSON.stringify({
            name: command.split(" ")[2],
            lines: state.logs,
            truncated: false,
          }),
        );
      return ok(JSON.stringify({ applied: [], removed: [] }));
    },
  };
  return { inventory, runtime, commands, state };
}
const web = { name: "web", command: "node server.js", port: 3000 };

test("declaring while awake saves, applies now and reports live status", async () => {
  const f = fixture({ live: { web: { state: "up", pid: 9, seconds: 1 } } });
  const view = await declareService(f.inventory, f.runtime, web, "agent");
  assert.deepEqual(computerServiceViewSchema.parse(view).status, {
    state: "up",
    pid: 9,
    seconds: 1,
  });
  assert.equal(view.declaredBy, "agent");
  assert.equal(
    f.commands.filter((c) => c.includes("fungi-services apply")).length,
    1,
  );
});

test("declaring never wakes a sleeping Computer", async () => {
  const f = fixture({ awake: false });
  const view = await declareService(f.inventory, f.runtime, web, "agent");
  assert.equal(view.status.state, "asleep");
  assert.deepEqual(f.commands, []);
  assert.equal(f.inventory.get("web")?.enabled, true);
});

test("a listing is live while awake and asleep otherwise, and shows a stopped service as down", async () => {
  const f = fixture({
    live: {
      web: { state: "up", pid: 4, seconds: 9 },
      worker: { state: "down", seconds: 2 },
    },
  });
  await declareService(f.inventory, f.runtime, web, "agent");
  await declareService(
    f.inventory,
    f.runtime,
    { name: "worker", command: "true" },
    "agent",
  );
  await setServiceEnabled(f.inventory, f.runtime, "worker", false);
  const awake = serviceListOutputSchema.parse(
    await listServices(f.inventory, f.runtime),
  );
  assert.deepEqual(
    awake.services.map(({ name, status }) => [name, status.state]),
    [
      ["web", "up"],
      ["worker", "down"],
    ],
  );
  f.state.awake = false;
  f.commands.length = 0;
  const asleep = await listServices(f.inventory, f.runtime);
  assert.deepEqual(
    asleep.services.map(({ status }) => status.state),
    ["asleep", "asleep"],
  );
  assert.deepEqual(f.commands, [], "reading never wakes the Computer");
});

test("an enabled service the supervisor has not rendered yet is restarting, not missing", async () => {
  const f = fixture({ live: {} });
  await declareService(f.inventory, f.runtime, web, "agent");
  assert.equal(
    (await listServices(f.inventory, f.runtime)).services[0].status.state,
    "restarting",
  );
});

test("stop and start change what is declared and apply it only while awake", async () => {
  const f = fixture({ live: { web: { state: "down", seconds: 1 } } });
  await declareService(f.inventory, f.runtime, web, "agent");
  f.commands.length = 0;
  const stopped = await setServiceEnabled(f.inventory, f.runtime, "web", false);
  assert.equal(stopped.enabled, false);
  assert.equal(
    f.commands.filter((c) => c.includes("fungi-services apply")).length,
    1,
  );
  f.state.awake = false;
  f.commands.length = 0;
  const started = await setServiceEnabled(f.inventory, f.runtime, "web", true);
  assert.equal(started.enabled, true);
  assert.equal(started.status.state, "asleep");
  assert.deepEqual(f.commands, []);
  await assert.rejects(
    setServiceEnabled(f.inventory, f.runtime, "missing", true),
    ComputerServiceNotFoundError,
  );
});

test("restart applies first, then restarts a service that was already running", async () => {
  const f = fixture({ live: { web: { state: "up", pid: 1, seconds: 3 } } });
  await declareService(f.inventory, f.runtime, web, "agent");
  f.commands.length = 0;
  await restartService(f.inventory, f.runtime, "web");
  assert.equal(f.commands.length, 3, "apply, restart, status");
  assert.match(f.commands[0], /fungi-services apply/u);
  assert.equal(f.commands[1], "fungi-services restart web");
  // A stopped one is started by the apply alone.
  await setServiceEnabled(f.inventory, f.runtime, "web", false);
  f.commands.length = 0;
  const view = await restartService(f.inventory, f.runtime, "web");
  assert.equal(view.enabled, true);
  assert.equal(
    f.commands.some((command) => command === "fungi-services restart web"),
    false,
  );
});

test("remove forgets the declaration and its port, applying while awake", async () => {
  const f = fixture();
  await declareService(f.inventory, f.runtime, web, "agent");
  f.commands.length = 0;
  assert.deepEqual(await removeService(f.inventory, f.runtime, "web"), {
    name: "web",
    removed: true,
  });
  assert.equal(f.inventory.get("web"), undefined);
  assert.equal(f.commands.length, 1);
  await assert.rejects(
    removeService(f.inventory, f.runtime, "web"),
    ComputerServiceNotFoundError,
  );
});

test("logs come from the running Computer, and a sleeping one has none to read", async () => {
  const f = fixture();
  await declareService(f.inventory, f.runtime, web, "agent");
  assert.deepEqual(
    await serviceLogs(f.inventory, f.runtime, { name: "web", lines: 50 }),
    {
      name: "web",
      lines: ["one", "two"],
      truncated: false,
    },
  );
  assert.ok(f.commands.at(-1).startsWith("fungi-services logs web 50"));
  f.state.awake = false;
  assert.deepEqual(await serviceLogs(f.inventory, f.runtime, { name: "web" }), {
    name: "web",
    lines: [],
    truncated: false,
  });
  await assert.rejects(
    serviceLogs(f.inventory, f.runtime, { name: "missing" }),
    ComputerServiceNotFoundError,
  );
});

test("a failed apply keeps the declaration and says why", async () => {
  const f = fixture();
  f.state.fail = {
    status: "completed",
    exitCode: 1,
    stdout: "",
    stderr: "s6-svscanctl: not running",
  };
  await assert.rejects(
    declareService(f.inventory, f.runtime, web, "agent"),
    (error) =>
      error instanceof ComputerServicesApplyError &&
      error.message.includes("not running"),
  );
  assert.equal(f.inventory.get("web")?.command, "node server.js");
});

test("a port another owner holds refuses the declaration before anything runs", async () => {
  const f = fixture();
  f.inventory.declare({ name: "a", command: "true", port: 3000 }, "owner:x");
  f.commands.length = 0;
  await assert.rejects(
    declareService(f.inventory, f.runtime, { ...web, name: "b" }, "agent"),
    ComputerPortConflictError,
  );
  assert.deepEqual(f.commands, []);
});
