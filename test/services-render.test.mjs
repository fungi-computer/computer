import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  applyInputSchema,
  parseSvstat,
  planApply,
  renderService,
  shellWord,
  tailLog,
} from "../container/services-render.mjs";

const options = {
  workspace: "/tmp",
  logRoot: "/var/cache/fungi-services/.logs",
};
/** Whether a process still runs; a zombie awaiting its reaper is gone. */
const alive = (pid) => {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  return state !== "" && !state.startsWith("Z");
};
const sh = (script, env = {}) =>
  execFileSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

test("a shell word keeps quotes, dollars, backticks, backslashes and newlines literal", () => {
  for (const text of [
    "plain",
    "it's",
    "$HOME `id` $(id)",
    "a\\b\\\\c",
    "line one\nline two",
    "'; echo pwned; '",
    "",
    "tab\there",
  ])
    assert.equal(sh(`printf %s ${shellWord(text)}`), text);
  assert.throws(() => shellWord("a\0b"), /NUL/);
});

test("the run file enters the cwd, exports plain env and runs the command as written", () => {
  const dir = mkdtempSync(join(tmpdir(), "services-render-"));
  try {
    const files = renderService(
      {
        name: "web",
        command: `printf '%s|%s|%s' "$GREETING" "$QUOTED" "$PWD" ; echo "it's $$" >/dev/null`,
        cwd: dir,
        env: { GREETING: "hello world", QUOTED: "it's $HOME `x`\nsecond" },
        enabled: true,
      },
      options,
    );
    assert.match(files.run, /^#!\/bin\/sh\n/);
    assert.equal(files.down, null);
    const run = join(dir, "run");
    writeFileSync(run, files.run, { mode: 0o755 });
    assert.equal(
      execFileSync(run, { encoding: "utf8", env: { PATH: process.env.PATH } }),
      `hello world|it's $HOME \`x\`\nsecond|${dir}`,
    );
    // A failing cd exits non-zero, so s6 retries instead of running elsewhere.
    writeFileSync(
      run,
      renderService(
        {
          name: "web",
          command: "echo ran",
          cwd: join(dir, "missing"),
          enabled: true,
        },
        options,
      ).run,
      { mode: 0o755 },
    );
    assert.throws(() => execFileSync(run, { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping the run file ends every process its command started, and a crash exit is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "services-render-"));
  try {
    const run = join(dir, "run");
    const marker = join(dir, "grandchild.pid");
    writeFileSync(
      run,
      renderService(
        {
          name: "web",
          command: `sh -c 'echo $$ > ${marker}; exec sleep 300' & wait`,
          enabled: true,
        },
        options,
      ).run,
      { mode: 0o755 },
    );
    // Its own session, as s6-supervise gives a service, so the group signal
    // cannot reach this test.
    const child = spawn("setsid", [run], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    for (let waited = 0; !existsSync(marker); waited += 1) {
      assert.ok(waited < 200, "the command did not start");
      await delay(25);
    }
    const grandchild = Number(readFileSync(marker, "utf8"));
    assert.equal(alive(grandchild), true);
    process.kill(child.pid, "SIGTERM");
    await exited;
    for (let waited = 0; alive(grandchild); waited += 1) {
      assert.ok(waited < 200, "the command's process survived the stop");
      await delay(25);
    }
    // A command that exits reports its own status, so s6 can tell a crash.
    writeFileSync(
      run,
      renderService({ name: "web", command: "exit 7", enabled: true }, options)
        .run,
      { mode: 0o755 },
    );
    assert.equal(spawnSync(run).status, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default directory is the Workspace and the logger keeps about 5 MB per service", () => {
  const files = renderService(
    { name: "web", command: "true", enabled: true },
    { workspace: "/workspace", logRoot: "/logs" },
  );
  assert.match(files.run, /cd '\/workspace' \|\| exit 1\n/);
  assert.equal(
    files.logRun,
    "#!/bin/sh\nexec s6-log n5 s1000000 '/logs/web'\n",
  );
  assert.equal(
    renderService({ name: "web", command: "true", enabled: false }, options)
      .down,
    "",
  );
});

test("applying controls only services s6 already supervises, and removes the rest", () => {
  const declared = (name, command, enabled = true) => ({
    name,
    command,
    enabled,
  });
  const unchanged = renderService(declared("same", "node a.js"), options).run;
  const plan = planApply(
    {
      services: [
        declared("fresh", "node f.js"),
        declared("same", "node a.js"),
        declared("changed", "node new.js"),
        declared("stopped", "node s.js", false),
        declared("fresh-stopped", "node x.js", false),
      ],
    },
    new Map([
      ["same", unchanged],
      ["changed", "#!/bin/sh\nold\n"],
      ["stopped", renderService(declared("stopped", "node s.js"), options).run],
      ["gone", "#!/bin/sh\n"],
    ]),
    options,
  );
  assert.deepEqual(
    plan.write.map(({ name, down }) => [name, down]),
    [
      ["fresh", null],
      ["same", null],
      ["changed", null],
      ["stopped", ""],
      ["fresh-stopped", ""],
    ],
  );
  // A new directory starts itself, or stays down, with no control command racing its supervisor.
  assert.deepEqual(plan.control, [
    { name: "same", command: "-u" },
    { name: "changed", command: "-ut" },
    { name: "stopped", command: "-d" },
  ]);
  assert.deepEqual(plan.remove, ["gone"]);
});

test("the apply input is a closed, bounded grammar", () => {
  const service = { name: "web", command: "true", enabled: true };
  assert.equal(
    applyInputSchema.safeParse({ services: [service] }).success,
    true,
  );
  assert.equal(applyInputSchema.safeParse({ services: [] }).success, true);
  for (const bad of [
    { services: [{ ...service, extra: 1 }] },
    { services: [{ ...service, name: "Web" }] },
    { services: [{ ...service, name: "../x" }] },
    { services: [{ ...service, cwd: "relative" }] },
    { services: [{ ...service, env: { "A-B": "x" } }] },
    { services: [{ ...service, command: "" }] },
    {
      services: Array.from({ length: 17 }, (_, i) => ({
        ...service,
        name: `s${String(i)}`,
      })),
    },
    { other: [] },
  ])
    assert.equal(applyInputSchema.safeParse(bad).success, false);
});

test("s6-svstat output becomes up, restarting or down", () => {
  assert.deepEqual(parseSvstat("true true 37 12\n"), {
    state: "up",
    pid: 37,
    seconds: 12,
  });
  assert.deepEqual(parseSvstat("false true 0\n"), {
    state: "restarting",
    seconds: 0,
  });
  assert.deepEqual(parseSvstat("false false 5\n"), {
    state: "down",
    seconds: 5,
  });
  assert.throws(
    () => parseSvstat("s6-svstat: fatal: unable to control"),
    /Unreadable/,
  );
});

test("a log tail keeps the newest lines and says when older ones were cut", () => {
  assert.deepEqual(tailLog("a\nb\nc\n", 5), {
    lines: ["a", "b", "c"],
    truncated: false,
  });
  assert.deepEqual(tailLog("a\nb\nc\n", 2), {
    lines: ["b", "c"],
    truncated: true,
  });
  assert.deepEqual(tailLog("", 3), { lines: [], truncated: false });
  assert.deepEqual(tailLog("no newline", 3), {
    lines: ["no newline"],
    truncated: false,
  });
});
