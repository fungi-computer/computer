import assert from "node:assert/strict";
import { test } from "node:test";
import { routeShellCommand } from "../src/light-shell.ts";

test("DO-file commands stay light instead of requesting a full execution backend", () => {
  assert.deepEqual(routeShellCommand("ls /workspace | head -3"), {
    where: "light",
  });
});

test("a program hidden in a substitution selects full before the outer command executes", () => {
  assert.deepEqual(routeShellCommand("echo $(node -v)"), {
    where: "full",
    reason: "node",
  });
});

test("navigation and exported variables stay in the light shell", () => {
  assert.deepEqual(
    routeShellCommand("cd app && export A=1 && jq . package.json"),
    {
      where: "light",
    },
  );
});

test("a file-only conditional stays light and a nested program escalates before execution", () => {
  assert.deepEqual(routeShellCommand("if true; then jq . package.json; fi"), {
    where: "light",
  });
  assert.deepEqual(routeShellCommand("if true; then npm install; fi"), {
    where: "full",
    reason: "npm",
  });
});

test("parameter-default substitutions are included before choosing the backend", () => {
  assert.deepEqual(routeShellCommand('echo "${A:-$(node -v)}"'), {
    where: "full",
    reason: "node",
  });
});

test("arithmetic substitutions also select full before the outer command executes", () => {
  assert.deepEqual(routeShellCommand('echo "$(( $(node -v) ))"'), {
    where: "full",
    reason: "node",
  });
});

test("compound-command redirections are checked before running the group", () => {
  assert.deepEqual(routeShellCommand('{ echo ready; } > "$(node -v)"'), {
    where: "full",
    reason: "node",
  });
});

test("keeps the approved light/full route table and quoted heredoc semantics", () => {
  for (const command of [
    "jq . proof.json | head -3",
    "$tool /workspace",
    "cat <<'EOF'\n$(node -v)\nEOF",
  ]) {
    assert.deepEqual(routeShellCommand(command), { where: "light" }, command);
  }
  for (const [command, reason] of [
    ["npm install", "npm"],
    ["git status", "git"],
    ["curl https://example.com", "curl"],
    ["sqlite3 proof.db", "sqlite3"],
    ["sleep 1 &", "background job"],
    ["cat <<EOF\n$(node -v)\nEOF", "node"],
  ]) {
    assert.deepEqual(
      routeShellCommand(command),
      { where: "full", reason },
      command,
    );
  }
  assert.equal(routeShellCommand("if true; then").where, "invalid");
});

test("completes a plain first command word from the real light capability set", async () => {
  const router = await import("../src/light-shell.ts");
  assert.deepEqual(router.completeShellCommand("gre"), [
    { name: "grep", where: "light" },
  ]);
  assert.deepEqual(router.completeShellCommand("np"), [
    { name: "npm", where: "full" },
    { name: "npx", where: "full" },
  ]);
  for (const source of ["cat file", "'gre'", "$tool", "echo hi | gre"]) {
    assert.equal(router.completeShellCommand(source), null, source);
  }
});

test("completion reports malformed syntax without inventing a token", async () => {
  const router = await import("../src/light-shell.ts");
  const completion = router.completeShellCommand("echo $(node");
  assert.ok(
    completion !== null &&
      !Array.isArray(completion) &&
      completion.kind === "invalid",
  );
});

test("full is a prompt control, with quotes serialized by the maintained transform", async () => {
  const router = await import("../src/light-shell.ts");
  const { Bash } = await import("just-bash/browser");
  const prepared = router.prepareShellPrompt(
    "full printf '%s' 'quoted; value'",
  );
  assert.equal(prepared.kind, "command");
  assert.equal(prepared.route.where, "full");
  const result = await new Bash({ commands: ["printf"] }).exec(
    prepared.command,
  );
  assert.equal(result.stdout, "quoted; value");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(router.prepareShellPrompt("light"), { kind: "light" });
  assert.deepEqual(router.prepareShellPrompt("exit"), { kind: "exit" });
  const switchFull = router.prepareShellPrompt("full");
  assert.equal(switchFull.kind, "command");
  assert.equal(switchFull.command, "");
  assert.equal(switchFull.route.where, "full");
});
