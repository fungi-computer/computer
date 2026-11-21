import assert from "node:assert/strict";
import { test } from "node:test";

import { execOutputSchema } from "@fungi.computer/computer-contract";

/** Same tagged shape as the Workspace's own transport error. */
class WorkspaceTransportError extends Error {
  name = "WorkspaceTransportError";
  constructor(message, options) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.stage = options?.stage;
  }
}
import { describeCommandFailure } from "../dist/command-failure.js";

test("a command that never reached dispatch is a failure that names its cause", () => {
  const outcome = describeCommandFailure({
    stage: "preparing",
    cause: new Error("DO is not container-enabled"),
    secrets: [],
    hosted: false,
  });
  assert.equal(outcome.kind, "not_started");
  const output = execOutputSchema.parse(outcome.output);
  assert.equal(output.status, "failed");
  assert.match(output.stderr, /did not start/u);
  assert.match(output.stderr, /DO is not container-enabled/u);
});

test("a command that may have started stays unknown and still names its cause", () => {
  const outcome = describeCommandFailure({
    stage: "dispatched",
    cause: new TypeError("socket closed"),
    secrets: [],
    hosted: false,
  });
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.cause, "TypeError: socket closed");
});

test("credential values never appear in a reported cause", () => {
  const outcome = describeCommandFailure({
    stage: "dispatched",
    cause: new Error("request failed for bearer fungi-git-pass-abcdef123456"),
    secrets: ["fungi-git-pass-abcdef123456"],
    hosted: false,
  });
  assert.equal(outcome.kind, "unknown");
  assert.ok(!outcome.cause.includes("abcdef123456"));
  assert.match(outcome.cause, /\[redacted\]/u);
});

test("a cause that is not an Error and a very long message are bounded", () => {
  const odd = describeCommandFailure({
    stage: "dispatched",
    cause: "boom",
    secrets: [],
    hosted: false,
  });
  assert.equal(odd.kind, "unknown");
  assert.equal(odd.cause, "Computer execution rejected with boom");
  const long = describeCommandFailure({
    stage: "dispatched",
    cause: new Error("x".repeat(5_000)),
    secrets: [],
    hosted: false,
  });
  assert.ok(long.cause.length <= 400);
});

test("a hosted runtime failure reports only the error name, never its message", () => {
  const outcome = describeCommandFailure({
    stage: "dispatched",
    cause: new Error(
      "exec rejected: env CARRIAGE=sentinel-one stdin=sentinel-two",
    ),
    secrets: [],
    hosted: true,
  });
  assert.equal(outcome.kind, "unknown");
  assert.equal(outcome.cause, "the native runtime failed (Error)");
  assert.ok(!outcome.cause.includes("sentinel-one"));
  assert.ok(!outcome.cause.includes("sentinel-two"));
  const odd = describeCommandFailure({
    stage: "dispatched",
    cause: "echoed sentinel-two",
    secrets: [],
    hosted: true,
  });
  assert.equal(odd.cause, "the native runtime failed");
});

test("a hosted transport failure names its typed connect stages and nothing else", () => {
  const start = new WorkspaceTransportError(
    "connect failed at stage=start lastError=sentinel-one echoed",
    { stage: "start" },
  );
  const egress = new WorkspaceTransportError("stage text", {
    stage: "egress",
    cause: start,
  });
  const outer = new WorkspaceTransportError("shell.exec failed after retry", {
    cause: egress,
  });
  const outcome = describeCommandFailure({
    stage: "dispatched",
    cause: outer,
    secrets: [],
    hosted: true,
  });
  assert.equal(outcome.kind, "unknown");
  assert.equal(
    outcome.cause,
    "the Computer did not wake (connect failed at stage=egress, stage=start)",
  );
  assert.ok(!outcome.cause.includes("sentinel-one"));
  assert.equal(
    describeCommandFailure({
      stage: "dispatched",
      cause: new WorkspaceTransportError("pipe closed with secret-xyz"),
      secrets: [],
      hosted: true,
    }).cause,
    "the Computer's runtime connection failed (WorkspaceTransportError)",
  );
});

test("an unknown stage string is dropped and a cyclic cause ends the walk", () => {
  const odd = new WorkspaceTransportError("x", { stage: "free text here" });
  assert.equal(
    describeCommandFailure({
      stage: "dispatched",
      cause: odd,
      secrets: [],
      hosted: true,
    }).cause,
    "the Computer's runtime connection failed (WorkspaceTransportError)",
  );
  const first = new WorkspaceTransportError("a", { stage: "start" });
  const second = new WorkspaceTransportError("b", {
    stage: "restart",
    cause: first,
  });
  first.cause = second;
  assert.equal(
    describeCommandFailure({
      stage: "dispatched",
      cause: first,
      secrets: [],
      hosted: true,
    }).cause,
    "the Computer did not wake (connect failed at stage=start, stage=restart)",
  );
});
