// Real sleep and wake of declared services on a real Computer runtime: a
// declared service runs again after the runtime is replaced, a stopped one
// stays stopped, and a killed one comes back. The runtime is the platform
// container under wrangler, or an on-box VM when COMPUTER_PROOF_RUNTIME=celld
// (see proof-worker.mjs).
import assert from "node:assert/strict";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { proofWorkers } from "./proof-worker.mjs";
import { proofClient, proofFailure } from "./proof-client.mjs";

const workers = await proofWorkers("computer-services-wake-proof");
let worker;
const { call, json } = proofClient(() => worker);
const post = (path, body) =>
  json(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const server = (message) =>
  `node -e 'require("http").createServer((q,r)=>r.end(process.pid+" ${message}")).listen(3000)'`;
const answer = async () => {
  const output = await call("bash", {
    command: `node -e 'fetch("http://127.0.0.1:3000").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.stdout.write("none"))'`,
    timeoutMs: 20_000,
  });
  return output.stdout === "none" ? null : output.stdout;
};
const status = async (name) =>
  (
    await call("bash", {
      command: `s6-svstat "$COMPUTER_SERVICES_DIR/${name}" 2>&1 || s6-svstat /var/cache/fungi-services/${name} 2>&1`,
      timeoutMs: 20_000,
    })
  ).stdout.trim();
const until = async (describe, probe, deadlineMs) => {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== false) return value;
    assert.ok(Date.now() < end, `timed out waiting for ${describe}`);
    await delay(500);
  }
};

try {
  worker = await workers.start();
  // The Agent tools, through the Computer's own capability door. Declared on a
  // Computer that has not started: saved, never woken.
  const declared = await call("declare_service", {
    name: "web",
    command: server("one"),
    port: 3000,
  });
  assert.equal(declared.status.state, "asleep");
  assert.equal(
    (await json("/container-running")).running,
    false,
    "declaring did not wake the Computer",
  );
  // Its first use starts a runtime, and the hook starts the declared service.
  await call("bash", { command: "true" });
  // Declared on a running Computer: started now.
  const parked = await call("declare_service", {
    name: "parked",
    command: "sleep 600",
  });
  assert.ok(["up", "restarting"].includes(parked.status.state));
  assert.equal(parked.enabled, true);
  assert.equal((await call("stop_service", { name: "parked" })).enabled, false);
  const first = await until("the service to answer", answer, 60_000);
  assert.match(first, /^\d+ one$/u);
  const listed = async () =>
    Object.fromEntries(
      (await call("list_services", {})).services.map(({ name, status }) => [
        name,
        status.state,
      ]),
    );
  assert.deepEqual(await listed(), { parked: "down", web: "up" });
  assert.match(
    await status("parked"),
    /^down /u,
    "a stopped service is not started",
  );
  const logs = await call("service_logs", { name: "web" });
  assert.equal(logs.name, "web");
  assert.ok(Array.isArray(logs.lines));

  // A killed service comes back with a new pid.
  await call("bash", { command: `kill -9 ${first.split(" ")[0]}` });
  const restarted = await until(
    "the killed service to restart",
    async () => {
      const text = await answer();
      return text !== null && text !== first ? text : null;
    },
    10_000,
  );
  assert.notEqual(restarted.split(" ")[0], first.split(" ")[0]);
  // restart_service replaces the running process on demand.
  await call("restart_service", { name: "web" });
  const demanded = await until(
    "the restarted service to answer",
    async () => {
      const text = await answer();
      return text !== null && text !== restarted ? text : null;
    },
    10_000,
  );

  // Sleep: the runtime goes away. Reading never wakes it.
  await post("/host-container-destroy", {});
  await delay(1_000);
  assert.equal(
    (await json("/container-running")).running,
    false,
    "the container is gone",
  );
  assert.deepEqual(await listed(), { parked: "asleep", web: "asleep" });
  assert.equal(
    (await json("/container-running")).running,
    false,
    "listing services did not wake the Computer",
  );
  // The next use wakes a new runtime, and the hook starts what is declared
  // there without anyone asking.
  const woken = await until("the service after wake", answer, 90_000);
  assert.match(woken, /^\d+ one$/u);
  assert.notEqual(woken, demanded, "a new runtime runs a new process");
  assert.match(
    await status("parked"),
    /^down /u,
    "a stopped service stays stopped",
  );
  assert.deepEqual(await listed(), { parked: "down", web: "up" });
  assert.deepEqual(await json("/ports"), { ports: [3000] });

  // Started again, it runs after the next wake too.
  await call("start_service", { name: "parked" });
  await post("/host-container-destroy", {});
  await until("the service after a second wake", answer, 90_000);
  await until(
    "parked up",
    async () => ((await listed()).parked === "up" ? true : null),
    30_000,
  );
  // Removed: gone from the list and stopped.
  assert.deepEqual(await call("remove_service", { name: "parked" }), {
    name: "parked",
    removed: true,
  });
  assert.deepEqual(Object.keys(await listed()), ["web"]);
  console.log(
    JSON.stringify({
      proof: "computer-services-wake",
      ok: true,
      runtime: workers.runtime,
    }),
  );
} catch (error) {
  throw proofFailure(error, workers, worker);
} finally {
  if (worker !== undefined) await workers.stop(worker);
}
