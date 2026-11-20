import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Prove declared services on a running Computer container, as its unprivileged
 * user: the supervisor starts them, restarts a killed one, stops and restarts
 * one on declaration, keeps its logs, and removes it. The container's
 * s6-svscan must already run on COMPUTER_SERVICES_DIR.
 */
export async function proveServices(
  container,
  { dir = "/var/cache/fungi-services" } = {},
) {
  const exec = async (script) =>
    (
      await run("docker", [
        "exec",
        "--user",
        "fungi",
        "--env",
        "HOME=/workspace",
        "--env",
        `COMPUTER_SERVICES_DIR=${dir}`,
        container,
        "sh",
        "-c",
        script,
      ])
    ).stdout;
  const apply = (services) =>
    exec(
      `echo ${Buffer.from(JSON.stringify({ services })).toString("base64")} | base64 -d | fungi-services apply`,
    );
  const server = (message) =>
    `node -e 'require("http").createServer((q,r)=>r.end(process.pid+" ${message}")).listen(3000)'`;
  const answer = async () => {
    try {
      return await exec(
        `node -e 'fetch("http://127.0.0.1:3000").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))'`,
      );
    } catch (error) {
      // The probe exits 1 when nothing answers; anything else is a real failure.
      if (error.code !== 1) throw error;
      return null;
    }
  };
  /** Poll to a deadline for the service to answer something new. */
  const answers = async (not, deadlineMs) => {
    const end = Date.now() + deadlineMs;
    for (;;) {
      const text = await answer();
      if (text !== null && text !== not) return text;
      assert.ok(Date.now() < end, "the service did not answer in time");
      await delay(100);
    }
  };
  /** Poll to a deadline for the service to stop answering. */
  const silent = async (deadlineMs) => {
    const end = Date.now() + deadlineMs;
    while ((await answer()) !== null) {
      assert.ok(Date.now() < end, "the service kept answering");
      await delay(100);
    }
  };
  const status = async () => (await exec(`s6-svstat ${dir}/web`)).trim();
  await exec(`pgrep -x s6-svscan >/dev/null`);

  const web = { name: "web", command: server("one"), enabled: true };
  assert.deepEqual(JSON.parse(await apply([web])).applied, ["web"]);
  const first = await answers(null, 10_000);
  assert.match(first, /^\d+ one$/u);
  assert.match(await status(), /^up \(pid \d+/u);

  // kill -9: it is up again within two seconds, with a new pid.
  const pid = first.split(" ")[0];
  await exec(`kill -9 ${pid}`);
  const second = await answers(first, 2_000);
  assert.notEqual(second.split(" ")[0], pid);

  // Stopped on declaration: down, and it stays down.
  await apply([{ ...web, enabled: false }]);
  await silent(5_000);
  for (let end = Date.now() + 5_000; !(await status()).startsWith("down ");)
    assert.ok(Date.now() < end, "s6 did not report the service down");
  // Re-enabled with new bytes: the replacement runs.
  await apply([{ ...web, command: server("two") }]);
  assert.match(await answers(null, 10_000), /^\d+ two$/u);

  // Its output is kept by the logger beside it, not in the Workspace.
  await exec(`ls ${dir}/.logs/web/current`);

  // Status is read from s6, never stored: running now, with its pid.
  const live = JSON.parse(await exec("fungi-services status")).services.web;
  assert.equal(live.state, "up");
  assert.ok(Number.isInteger(live.pid) && live.pid > 0);
  // Logs: the retained tail, newest last.
  await apply([
    {
      ...web,
      command: `echo first; echo "second it's"; ${server("three")}`,
    },
  ]);
  // The replaced process may still answer for a moment: wait for the new run's output.
  let tail;
  for (let end = Date.now() + 10_000; ;) {
    tail = JSON.parse(await exec("fungi-services logs web 200"));
    if (tail.lines.at(-1) === "second it's") break;
    assert.ok(Date.now() < end, "the new run's output was not logged");
    await delay(100);
  }
  assert.deepEqual(tail.lines.slice(-2), ["first", "second it's"]);
  const newest = JSON.parse(await exec("fungi-services logs web 1"));
  assert.deepEqual(newest.lines, ["second it's"]);
  assert.equal(newest.truncated, true);
  await answers(null, 10_000);
  // Restart: a new process replaces the running one.
  const before = await answers(null, 5_000);
  JSON.parse(await exec("fungi-services restart web"));
  assert.notEqual(
    (await answers(before, 10_000)).split(" ")[0],
    before.split(" ")[0],
  );

  // Declared and stopped back to back, before the supervisor has even looked
  // at the first: it must end down, not up.
  const parked = {
    name: "parked",
    command: "sleep 600",
    enabled: true,
  };
  await apply([{ ...web, command: server("two") }, parked]);
  await apply([
    { ...web, command: server("two") },
    { ...parked, enabled: false },
  ]);
  for (let end = Date.now() + 5_000; ;) {
    const state = JSON.parse(await exec("fungi-services status")).services
      .parked?.state;
    if (state === "down") break;
    assert.ok(Date.now() < end, `parked is ${String(state)}, not down`);
    await delay(100);
  }

  // Removed: gone, process and directory.
  await apply([]);
  await silent(5_000);
  await exec(`test ! -e ${dir}/web`);
  return { restartedWithin: "2s" };
}
