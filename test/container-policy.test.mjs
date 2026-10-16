import assert from "node:assert/strict";
import test from "node:test";
import {
  ComputerContainersPausedError,
  computerContainerSleepAfterMs,
  assertComputerContainersEnabled,
  configureComputerContainer,
  hostedComputerContainersPaused,
} from "../dist/container-policy.js";
import {
  boundedRuntimeMs,
  boundedVmResources,
  computerRuntimeExpired,
  computerResourceBounds,
} from "../container/resource-bounds.mjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("production Computer image never copies the box's proof-only CA", async () => {
  const dockerfile = await readFile(
    resolve(repositoryRoot, "packages/computer/Dockerfile"),
    "utf8",
  );
  assert.doesNotMatch(dockerfile, /^\s*COPY\b[^\n]*\.crt\b/imu);
  assert.doesNotMatch(
    dockerfile,
    /host-ca-bundle\.crt|\/etc\/fungi-proof\/host-ca\.crt|http\.sslCAInfo/iu,
  );
});

test("Git uses the runtime merged CA bundle with verification enabled", async () => {
  const dockerfile = await readFile(
    resolve(repositoryRoot, "packages/computer/Dockerfile"),
    "utf8",
  );
  assert.match(dockerfile, /^ENV SSL_CERT_FILE=\/tmp\/fungi-ca-bundle\.crt$/mu);
  assert.match(
    dockerfile,
    /^ENV GIT_SSL_CAINFO=\/tmp\/fungi-ca-bundle\.crt$/mu,
  );
  assert.doesNotMatch(
    dockerfile,
    /GIT_SSL_NO_VERIFY|http\.sslVerify\s+false/iu,
  );
});

test("container acquisition configures the 15 minute inactivity timeout", async () => {
  const timeouts = [];
  await configureComputerContainer({
    setInactivityTimeout: async (timeout) => timeouts.push(timeout),
  });
  assert.deepEqual(timeouts, [15 * 60 * 1_000]);
  assert.equal(computerContainerSleepAfterMs, 15 * 60 * 1_000);
});

test("the container kill switch refuses before configuring a container", async () => {
  let configured = false;
  await assert.rejects(
    async () => assertComputerContainersEnabled("paused"),
    ComputerContainersPausedError,
  );
  assert.equal(configured, false);
});

test("an unrecognized kill switch value fails closed", async () => {
  assert.equal(hostedComputerContainersPaused("unexpected"), true);
  assert.throws(
    () => assertComputerContainersEnabled("unexpected"),
    ComputerContainersPausedError,
  );
});

async function assertConfiguredComputerBounds(configPath) {
  const source = await readFile(resolve(repositoryRoot, configPath), "utf8");
  const { config, error } = ts.parseConfigFileTextToJson(configPath, source);
  assert.equal(error, undefined, configPath);
  const containers = [config.containers, config.previews?.containers].flatMap(
    (entries) => entries ?? [],
  );
  for (const container of containers) {
    if (container.class_name !== "ComputerDO") continue;
    assert.equal(container.instance_type, "standard-4", configPath);
  }
}

test("every configured platform Computer has the same CPU, memory and disk ceiling", async () => {
  const configPaths = [
    "apps/hub/wrangler.jsonc",
    "apps/demo/wrangler.jsonc",
    "packages/computer/wrangler.test.jsonc",
    "packages/computer/wrangler.egress-test.jsonc",
  ];
  for (const configPath of configPaths)
    await assertConfiguredComputerBounds(configPath);
  assert.deepEqual(
    {
      vcpus: computerResourceBounds.vcpus,
      memoryMib: computerResourceBounds.memoryMib,
      diskGib: computerResourceBounds.diskGib,
    },
    { vcpus: 4, memoryMib: 12_288, diskGib: 20 },
  );
});

test("the VM host refuses a larger Computer and an extended runtime", () => {
  const safe = {
    vcpus: 4,
    memMib: 12_288,
    diskGib: 20,
    pidsMax: 256,
  };
  assert.deepEqual(boundedVmResources(safe), safe);
  for (const field of Object.keys(safe))
    assert.throws(() =>
      boundedVmResources({ ...safe, [field]: safe[field] + 1 }),
    );
  assert.equal(boundedRuntimeMs(undefined), 86_400_000);
  assert.equal(boundedRuntimeMs("1000"), 1_000);
  assert.throws(() => boundedRuntimeMs("86400001"));
  assert.equal(computerRuntimeExpired(1_000, 1_999, 1_000), false);
  assert.equal(computerRuntimeExpired(1_000, 2_000, 1_000), true);
});
