import assert from "node:assert/strict";
import console from "node:console";
import { proofWorkers } from "./proof-worker.mjs";

// The Computer loads the shell's core group and its jq, yq, xan and file
// groups when a shell Worker is minted, not at startup. Run one command per
// group through a real Worker Loader so a broken loader fails here.
const workers = await proofWorkers("shell-groups", {
  main: "test/shell-groups.fixture.ts",
  wranglerConfig: "test/shell-groups.wrangler.json",
});
let worker;
try {
  worker = await workers.start();
  const run = async (command) => {
    const response = await globalThis.fetch(
      `${worker.baseUrl}/run?command=${encodeURIComponent(command)}`,
    );
    if (response.status !== 200)
      assert.fail(
        `${command}: ${String(response.status)} ${await response.text()}`,
      );
    return await response.json();
  };
  for (const [group, command, expected] of [
    ["core", "ls", "sample.csv"],
    ["jq", `echo '{"a":1}' | jq .a`, "1"],
    ["yq", "yq .a.b sample.yaml", "7"],
    ["xan", "xan count sample.csv", "2"],
    ["file", "file sample.csv", "csv"],
  ]) {
    const result = await run(command);
    assert.equal(result.exitCode, 0, `${group}: ${JSON.stringify(result)}`);
    assert.ok(
      result.stdout.includes(expected),
      `${group}: ${JSON.stringify(result)}`,
    );
    console.log(`PASS the ${group} shell group runs \`${command}\``);
  }
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
