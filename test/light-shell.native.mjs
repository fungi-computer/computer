/* global fetch */
import assert from "node:assert/strict";
import console from "node:console";
import { execOutputSchema } from "@fungi.computer/computer-contract";
import * as z from "zod";
import process from "node:process";
import { proofWorkers } from "./proof-worker.mjs";
import { proofClient, proofFailure } from "./proof-client.mjs";

const workers = await proofWorkers("light-shell", {
  main: "test/light-shell.fixture.ts",
  hosted: false,
});
let worker;
try {
  worker = await workers.start();
  const client = proofClient(() => worker);
  await client.call("mkdir", { path: "/workspace" });
  await client.call("write", {
    path: "/workspace/proof.json",
    content: '{"message":"light without a container"}',
  });
  if (process.argv.includes("--state")) {
    await client.call("mkdir", { path: "/workspace/sub" });
    const response = await (
      await fetch(`${worker.baseUrl}/state-events`)
    ).json();
    const events = z.array(z.json()).parse(response);
    const stateEvent = z.strictObject({
      id: z.string(),
      seq: z.number(),
      name: z.literal("state"),
      value: z.strictObject({
        cwd: z.string(),
        env: z.record(z.string(), z.string()),
      }),
    });
    const states = events.flatMap((event) => {
      const parsed = stateEvent.safeParse(event);
      return parsed.success ? [parsed.data.value] : [];
    });
    assert.equal(
      states.length,
      1,
      "one final shell state must reach the native caller",
    );
    assert.equal(states[0].cwd, "/workspace/sub");
    assert.equal(states[0].env.A, "1");
    const roundTrip = z
      .object({
        first: z.object({
          state: z.object({
            cwd: z.string(),
            env: z.record(z.string(), z.string()),
          }),
        }),
        next: z.object({ stdout: z.string(), exitCode: z.number() }),
      })
      .parse(await (await fetch(`${worker.baseUrl}/state-round-trip`)).json());
    assert.equal(roundTrip.first.state.cwd, "/workspace/sub");
    assert.equal(roundTrip.first.state.env.A, "1");
    assert.equal(roundTrip.next.exitCode, 0);
    assert.equal(roundTrip.next.stdout, "/workspace/sub:1");
    console.log("PASS native celld light state: cwd and exported A preserved");
  }
  const result = execOutputSchema.parse(
    await client.call("exec", {
      command: "jq -r .message proof.json",
      cwd: "/workspace",
      timeoutMs: 30000,
    }),
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "light without a container\n");
  const admissions = z
    .strictObject({ count: z.number().int().nonnegative() })
    .parse(await (await fetch(`${worker.baseUrl}/hosted-admissions`)).json());
  assert.equal(
    admissions.count,
    0,
    "the DO-file shell must not request a full backend",
  );
  console.log(
    "PASS native celld light shell: jq over SQLite files; hosted admissions 0",
  );
} catch (cause) {
  throw proofFailure(cause, workers, worker);
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
