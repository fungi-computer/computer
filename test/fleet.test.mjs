import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { checkComputerGrant } from "../dist/fleet/index.js";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { computerInternetAccess } from "../dist/internet-access.js";

test("a Computer's Internet access defaults on and persists off independently of other Computers", () => {
  const first = new DatabaseSync(":memory:");
  const second = new DatabaseSync(":memory:");
  try {
    const firstSql = fromNodeSqlite(first).sql;
    const secondSql = fromNodeSqlite(second).sql;
    assert.equal(computerInternetAccess(firstSql), true);
    assert.equal(computerInternetAccess(secondSql), true);
    assert.equal(computerInternetAccess(firstSql, false), false);
    // A new storage adapter observes the persisted value, not process state.
    assert.equal(computerInternetAccess(fromNodeSqlite(first).sql), false);
    assert.equal(computerInternetAccess(secondSql), true);
    assert.equal(computerInternetAccess(firstSql, true), true);
  } finally {
    first.close();
    second.close();
  }
});

test("usage facts keep their Computer and provenance through delivery acknowledgment", async () => {
  const { ComputerRuntimeUsage } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const usage = new ComputerRuntimeUsage(
      fromNodeSqlite(database).sql,
      60_000,
    );
    usage.started({
      runtimeId: "runtime-one",
      backing: { kind: "platform-container" },
      startedAt: 1_000,
    });
    usage.observe("runtime-one", { running: false, endedAt: 2_000 });
    const facts = usage.pendingFacts("computer-one", { actor: "computer-one" });
    assert.deepEqual(facts, [
      {
        kind: "interval",
        computerId: "computer-one",
        provenance: { actor: "computer-one" },
        runtimeId: "runtime-one",
        backing: { kind: "platform-container" },
        startedAt: 1_000,
        observedAt: 2_000,
        ended: true,
      },
    ]);
    assert.deepEqual(
      usage.pendingFacts("computer-one", { actor: "computer-one" }),
      facts,
    );
    usage.acknowledge(facts);
    assert.deepEqual(
      usage.pendingFacts("computer-one", { actor: "computer-one" }),
      [],
    );
  } finally {
    database.close();
  }
});

test("a host grant admits only its Computer, action and lifetime", () => {
  const grant = {
    computerId: "computer-one",
    actions: new Set(["exec", "files.read"]),
    expiresAt: 2_000,
    provenance: { actor: "owner-one", via: "invocation-one" },
  };
  const request = { computerId: "computer-one", action: "exec", now: 1_000 };
  assert.deepEqual(checkComputerGrant(grant, request), { kind: "admitted" });
  assert.deepEqual(
    checkComputerGrant(grant, { ...request, computerId: "computer-two" }),
    { kind: "Refused", reason: "computer" },
  );
  assert.deepEqual(
    checkComputerGrant(grant, { ...request, action: "files.write" }),
    { kind: "Refused", reason: "action" },
  );
  assert.deepEqual(checkComputerGrant(grant, { ...request, now: 2_000 }), {
    kind: "Refused",
    reason: "expired",
  });
});

test("backing is recorded at creation and survives an owner reconstruction", async () => {
  const { createFleetBacking } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const backing = createFleetBacking(owner);
    backing.ensure();
    const configured = [{ kind: "platform-container" }];
    assert.deepEqual(backing.computerCreated("one", configured), {
      computerId: "one",
      revision: 0,
      backends: [{ kind: "platform-container" }],
    });
    // A later configuration value cannot rewrite an already-created Computer.
    configured.splice(0, 1, { kind: "on-box-vm", hostId: "host-one" });
    backing.computerCreated("one", configured);
    backing.computerCreated("two", configured);
    const resumed = createFleetBacking(owner);
    assert.deepEqual(resumed.resolve("one"), [{ kind: "platform-container" }]);
    assert.deepEqual(resumed.resolve("two"), [
      { kind: "on-box-vm", hostId: "host-one" },
    ]);
  } finally {
    database.close();
  }
});

test("grant authority has no paid-usage budget or command timeout", async () => {
  const { computerGrantSchema } = await import("../dist/fleet/index.js");
  const grant = {
    computerId: "computer-one",
    actions: new Set(["exec"]),
    expiresAt: 30_000,
    provenance: { actor: "owner-one" },
  };
  assert.equal(computerGrantSchema.safeParse(grant).success, true);
  assert.equal(
    computerGrantSchema.safeParse({
      ...grant,
      budget: { maximumTimeMs: 5_000 },
    }).success,
    false,
  );
  assert.equal(
    computerGrantSchema.safeParse({ ...grant, timeoutMs: 5_000 }).success,
    false,
  );
  assert.deepEqual(
    checkComputerGrant(grant, {
      computerId: "computer-one",
      action: "exec",
      now: 1_000,
    }),
    { kind: "admitted" },
  );
});

test("explicit backing changes return whole revisions without a host callback", async () => {
  const { createFleetBacking } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const backing = createFleetBacking(fromNodeSqlite(database));
    backing.ensure();
    backing.computerCreated("one", [{ kind: "platform-container" }]);
    backing.computerCreated("two", []);
    const config = {
      offered: new Set(["platform-container", "on-box-vm"]),
      computerIds: ["one", "two"],
    };
    const vm = { kind: "on-box-vm", hostId: "host-one" };
    assert.deepEqual(backing.change("owner", { backings: [vm] }, config), {
      revision: 1,
      projections: [
        { computerId: "one", revision: 1, backends: [vm] },
        { computerId: "two", revision: 1, backends: [vm] },
      ],
    });
    backing.change("owner", { computerId: "one", backings: [] }, config);
    assert.deepEqual(backing.resolve("one"), []);
    backing.change("owner", { computerId: "one", backings: null }, config);
    assert.deepEqual(backing.resolve("one"), [vm]);
    assert.throws(
      () =>
        backing.change(
          "owner",
          { backings: [{ kind: "platform-container" }] },
          {
            ...config,
            offered: new Set(["on-box-vm"]),
          },
        ),
      { code: "not_enabled" },
    );
    assert.deepEqual(backing.resolve("two"), [vm]);
  } finally {
    database.close();
  }
});

test("local attachment replay, ownership and cancellation survive reconstruction", async () => {
  const { createFleetBacking } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const backing = createFleetBacking(owner);
    backing.ensure();
    backing.computerCreated("one", []);
    const input = {
      computerId: "one",
      requestId: "attach-one",
      publicKey: Buffer.alloc(32, 7).toString("base64"),
      hostLabel: "Laptop",
      folderLabel: "Project",
    };
    const attached = backing.attachLocal("owner", input);
    assert.equal(attached.projections.length, 1);
    assert.equal(attached.projections[0].revision, 1);
    assert.equal(attached.projections[0].backends[0].hostLabel, "Laptop");
    const resumed = createFleetBacking(owner);
    assert.deepEqual(resumed.attachLocal("owner", input), {
      backendId: attached.backendId,
      projections: [],
    });
    assert.throws(
      () =>
        resumed.attachLocal("owner", { ...input, folderLabel: "Elsewhere" }),
      { code: "request_conflict" },
    );
    assert.throws(
      () =>
        resumed.detachLocal("someone-else", {
          computerId: "one",
          backendId: attached.backendId,
        }),
      { code: "not_owner" },
    );
    assert.deepEqual(
      resumed.detachLocal("owner", {
        computerId: "one",
        requestId: "attach-one",
      }),
      {
        detached: true,
        projections: [{ computerId: "one", revision: 2, backends: [] }],
      },
    );
    assert.throws(() => backing.attachLocal("owner", input), {
      code: "request_conflict",
    });
  } finally {
    database.close();
  }
});

test("usage facts retain provenance and runtime interval identity for host settlement", async () => {
  const { computerFactSchema } = await import("../dist/fleet/index.js");
  const fact = {
    kind: "interval",
    computerId: "one",
    provenance: { actor: "owner", via: "invocation-one" },
    runtimeId: "runtime-one",
    backing: { kind: "platform-container" },
    startedAt: 1_000,
    observedAt: 2_000,
    ended: false,
  };
  assert.deepEqual(
    computerFactSchema.parse(JSON.parse(JSON.stringify(fact))),
    fact,
  );
  const unattributed = globalThis.structuredClone(fact);
  delete unattributed.provenance;
  assert.equal(computerFactSchema.safeParse(unattributed).success, false);
});

test("a host withdrawal removes only that actor's machines across the fleet", async () => {
  const { createFleetBacking } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const backing = createFleetBacking(fromNodeSqlite(database));
    backing.ensure();
    for (const computerId of ["one", "two"]) {
      backing.computerCreated(computerId, []);
      backing.attachLocal("departed", {
        computerId,
        requestId: computerId,
        publicKey: Buffer.alloc(32, 7).toString("base64"),
        hostLabel: "Laptop",
        folderLabel: "Project",
      });
    }
    const retained = backing.attachLocal("retained", {
      computerId: "one",
      requestId: "retained",
      publicKey: Buffer.alloc(32, 8).toString("base64"),
      hostLabel: "Other",
      folderLabel: "Project",
    });
    const result = backing.detachActorLocal("departed");
    assert.equal(result.detached, 2);
    assert.deepEqual(
      result.projections.map(({ computerId, revision }) => ({
        computerId,
        revision,
      })),
      [
        { computerId: "one", revision: 4 },
        { computerId: "two", revision: 4 },
      ],
    );
    assert.deepEqual(
      [...backing.localOwners("one")],
      [[retained.backendId, "retained"]],
    );
    assert.deepEqual(backing.resolve("two"), []);
    assert.deepEqual(backing.detachActorLocal("departed"), {
      detached: 0,
      projections: [],
    });
  } finally {
    database.close();
  }
});

test("fleet inventory preserves create identity and exposes replay before host admission", async () => {
  const { createFleetInventory } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const inventory = createFleetInventory(owner);
    inventory.ensure();
    const actor = { kind: "owner", id: "one" };
    const request = { name: "Cedar", requestId: "create-one" };
    assert.equal(inventory.replay(actor, request), null);
    const created = inventory.create(actor, request);
    const reopened = createFleetInventory(owner);
    assert.deepEqual(reopened.replay(actor, request), created);
    assert.equal(reopened.count(), 1);
    assert.deepEqual(reopened.list({}), {
      computers: [created],
      nextOffset: null,
    });
    assert.throws(
      () => reopened.replay({ kind: "owner", id: "two" }, request),
      {
        code: "request_conflict",
      },
    );
    assert.throws(() => reopened.replay(actor, { ...request, name: "Birch" }), {
      code: "request_conflict",
    });
  } finally {
    database.close();
  }
});

test("fleet slots retain idempotent reservation and report unavailable storage as data", async () => {
  const { createFleetSlots } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const slots = createFleetSlots(fromNodeSqlite(database), {
      limit: 2,
      retryAfterSeconds: 30,
    });
    slots.ensure();
    assert.deepEqual(slots.reserve("one"), {
      kind: "reserved",
      runningComputers: 1,
    });
    assert.deepEqual(slots.reserve("one"), {
      kind: "reserved",
      runningComputers: 1,
    });
    assert.deepEqual(slots.reserve("two"), {
      kind: "reserved",
      runningComputers: 2,
    });
    assert.deepEqual(slots.reserve("three"), {
      kind: "capacity",
      runningComputers: 2,
      limit: 2,
      retryAfterSeconds: 30,
    });
    slots.release("one");
    slots.release("one");
    assert.deepEqual(slots.reserve("three"), {
      kind: "reserved",
      runningComputers: 2,
    });
    database.close();
    const failed = slots.reserve("four");
    assert.equal(failed.kind, "unavailable");
    assert.ok(failed.cause instanceof Error);
  } finally {
    if (database.isOpen) database.close();
  }
});

test("fleet lifecycle checks its grant before native execution and returns release facts", async () => {
  const { FleetLifecycle, FleetGrantRefused } =
    await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const fleet = new FleetLifecycle({
      storage: fromNodeSqlite(database),
      computerId: "one",
      backend: { state: { container: { running: false } } },
    });
    const backing = { kind: "platform-container" };
    const grant = {
      computerId: "one",
      actions: new Set(["start"]),
      expiresAt: Date.now() + 60_000,
      provenance: { actor: "owner" },
    };
    let executed = 0;
    const run = async () => {
      executed++;
      return "native result";
    };
    await assert.rejects(
      fleet.run({ ...grant, computerId: "two" }, backing, run),
      FleetGrantRefused,
    );
    await assert.rejects(
      fleet.run({ ...grant, actions: new Set() }, backing, run),
      FleetGrantRefused,
    );
    assert.equal(executed, 0);
    assert.equal(await fleet.run(grant, backing, run), "native result");
    assert.equal(executed, 1);
    assert.deepEqual(fleet.takeFacts(), [{ kind: "reservation.release" }]);
    assert.deepEqual(fleet.takeFacts(), []);
  } finally {
    database.close();
  }
});

test("an empty runtime roster does not hide an in-flight hosted operation", async () => {
  const { FleetLifecycle } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let running;
  try {
    const fleet = new FleetLifecycle({
      storage: fromNodeSqlite(database),
      computerId: "pending",
      backend: { state: { container: { running: false } } },
    });
    assert.equal(fleet.hasPendingOperations, false);
    running = fleet.run(
      {
        computerId: "pending",
        actions: new Set(["start"]),
        expiresAt: Date.now() + 60_000,
        provenance: { actor: "owner" },
      },
      { kind: "platform-container" },
      async () => {
        entered.resolve();
        await finish.promise;
      },
    );
    await entered.promise;
    assert.deepEqual(await fleet.stopAll("retirement"), []);
    assert.equal(fleet.hasPendingOperations, true);
    finish.resolve();
    await running;
    assert.equal(fleet.hasPendingOperations, false);
  } finally {
    finish.resolve();
    await running;
    database.close();
  }
});

test("a recycling restart stays pending across stop readback until its late boot is stopped", async (t) => {
  const { FleetLifecycle } = await import("../dist/fleet/index.js");
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const database = new DatabaseSync(":memory:");
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const watches = [];
  let recycling;
  let current = { running: true, runtimeId: "old", exit: null };
  const backing = { kind: "on-box-vm", hostId: "host-one" };
  try {
    const fleet = new FleetLifecycle({
      storage: {
        ...fromNodeSqlite(database),
        getAlarm: async () => null,
        setAlarm: async () => undefined,
      },
      alarm: { waitUntil: (work) => watches.push(work) },
      computerId: "recycling",
      backend: {
        state: { id: { toString: () => "recycling" } },
        onBoxVmHost: () => ({
          inventory: async () => [
            {
              id: "recycling",
              running: true,
              runtimeId: "old",
              lastActive: 1_000,
            },
          ],
          state: async () => current,
          destroy: async () => {
            current = { running: false, runtimeId: null, exit: null };
          },
        }),
        syncRecycledWorkspace: async () => undefined,
        hostedContainerHost: () => ({
          restart: async () => {
            entered.resolve();
            await finish.promise;
            current = { running: true, runtimeId: "replacement", exit: null };
            return { runtimeId: "replacement" };
          },
        }),
      },
    });
    fleet.containerRuntimeStarted({
      runtimeId: "old",
      backing,
      startedAt: now,
    });
    await Promise.all(watches);
    now += 24 * 60 * 60_000;
    recycling = fleet.recycle({
      computerId: "recycling",
      actions: new Set(["start"]),
      expiresAt: now + 60_000,
      provenance: { actor: "owner" },
    });
    await entered.promise;
    assert.deepEqual(await fleet.stopAll("retirement"), []);
    assert.equal(fleet.hasPendingOperations, true);
    finish.resolve();
    await recycling;
    assert.equal(fleet.hasPendingOperations, false);
    assert.deepEqual(await fleet.stopAll("retirement retry"), []);
    assert.equal(current.running, false);
  } finally {
    finish.resolve();
    await recycling;
    await Promise.all(watches);
    database.close();
  }
});

test("multiple Computers start through the same fleet owner without crossing backend identities", async () => {
  const { FleetLifecycle } = await import("../dist/fleet/index.js");
  for (const computerId of ["A", "B"]) {
    const database = new DatabaseSync(":memory:");
    try {
      const calls = [];
      const backing = { kind: "platform-container" };
      const fleet = new FleetLifecycle({
        storage: fromNodeSqlite(database),
        computerId,
        backend: {
          requireHostedRoute: () => ({ backing, id: computerId }),
          workspace: () => ({
            push: async (id) => {
              calls.push(id);
              return 0;
            },
          }),
          containerRunning: async () => true,
        },
      });
      const admitted = async (selected, run) => {
        assert.deepEqual(selected, backing);
        return run();
      };
      assert.deepEqual(await fleet.startHostedComputer(admitted), {
        state: "running",
      });
      assert.deepEqual(calls, [computerId]);
      await assert.rejects(
        fleet.startHostedComputer(async () => {
          throw new Error("unfunded");
        }),
        /unfunded/,
      );
      assert.deepEqual(calls, [computerId]);
    } finally {
      database.close();
    }
  }
});

test("fleet creation commits inventory and backing together and returns projections once", async () => {
  const { createFleetComputers } = await import("../dist/fleet/index.js");
  const database = new DatabaseSync(":memory:");
  try {
    const fleet = createFleetComputers(fromNodeSqlite(database), {
      limit: 2,
      retryAfterSeconds: 30,
    });
    fleet.ensure();
    const actor = { kind: "owner", id: "one" };
    const request = { name: "Cedar", requestId: "create-one" };
    const created = fleet.create(actor, request, [
      { kind: "platform-container" },
    ]);
    assert.deepEqual(created.projections, [
      {
        computerId: created.computer.computerId,
        revision: 0,
        backends: [{ kind: "platform-container" }],
      },
    ]);
    assert.deepEqual(fleet.readBacking(created.computer.computerId), [
      { kind: "platform-container" },
    ]);
    assert.deepEqual(fleet.create(actor, request, []), {
      computer: created.computer,
      projections: [],
    });
    assert.throws(() =>
      fleet.create(actor, { requestId: "invalid", name: "Birch" }, [
        { kind: "unknown" },
      ]),
    );
    assert.equal(fleet.count(), 1);
  } finally {
    database.close();
  }
});
