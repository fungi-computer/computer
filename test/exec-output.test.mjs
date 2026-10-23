import assert from "node:assert/strict";
import { test } from "node:test";
import { TextEncoder } from "node:util";

import { boundExecStream } from "../dist/exec-output.js";
import { execOutputSchema } from "@fungi.computer/computer-contract";

for (const stream of ["stdout", "stderr"]) {
  test(`${stream} over 64 KiB gets a marker and a typed entry`, () => {
    const text = "€".repeat(40_000);
    const bounded = boundExecStream(text, stream);
    const total = new TextEncoder().encode(text).byteLength;
    assert.match(
      bounded.value,
      new RegExp(
        `\\n\\[fungi: ${stream} truncated: [\\d.]+ KiB of ${(total / 1024).toFixed(1)} KiB shown; redirect to a file or use head/tail\\]$`,
        "u",
      ),
    );
    assert.ok(!bounded.value.includes("\ufffd"));
    assert.equal(bounded.truncation.length, 1);
    assert.equal(bounded.truncation[0].stream, stream);
    assert.equal(bounded.truncation[0].totalBytes, total);
    assert.ok(new TextEncoder().encode(bounded.value).byteLength <= 65538);
    const output = {
      status: "completed",
      exitCode: 0,
      stdout: stream === "stdout" ? bounded.value : "",
      stderr: stream === "stderr" ? bounded.value : "",
      truncated: bounded.truncation,
    };
    assert.deepEqual(execOutputSchema.parse(output), output);
  });
}

test("a stream within the bound is returned whole", () => {
  assert.deepEqual(boundExecStream("ok", "stdout"), {
    value: "ok",
    truncation: [],
  });
});
