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
  computerSizeResources,
  computerSizes,
  platformContainerResources,
} from "../container/resource-bounds.mjs";
import { computerSizeSchema } from "../dist/computer-backends.js";
import { computerSizeUnits, unitsPerDefaultVm } from "../dist/host-config.js";
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

test("the platform inactivity timeout is a 15 minute backstop, raised only for Keep awake", async () => {
  const timeouts = [];
  const container = {
    setInactivityTimeout: async (timeout) => timeouts.push(timeout),
  };
  await configureComputerContainer(container, false);
  await configureComputerContainer(container, true);
  assert.deepEqual(timeouts, [15 * 60 * 1_000, 24 * 60 * 60 * 1_000]);
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

test("every configured platform Computer is the one fixed instance", async () => {
  const configPaths = [
    "apps/hub/wrangler.jsonc",
    "packages/computer/wrangler.test.jsonc",
    "packages/computer/wrangler.egress-test.jsonc",
  ];
  for (const configPath of configPaths)
    await assertConfiguredComputerBounds(configPath);
  // Cloudflare's standard-4: containers keep one size whatever a Computer chose.
  assert.deepEqual(platformContainerResources, {
    vcpus: 4,
    memoryMib: 12_288,
  });
  assert.equal(computerResourceBounds.diskGib, 20);
});

test("each Computer size selects its VM resources within the largest size", () => {
  assert.deepEqual(computerSizeSchema.options, Object.keys(computerSizes));
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(computerSizes).map((size) => [
        size,
        computerSizeResources(size),
      ]),
    ),
    {
      small: { vcpus: 2, memMib: 4_096 },
      default: { vcpus: 4, memMib: 8_192 },
      large: { vcpus: 8, memMib: 16_384 },
    },
  );
  assert.deepEqual(
    {
      vcpus: computerResourceBounds.vcpus,
      memMib: computerResourceBounds.memoryMib,
    },
    computerSizeResources("large"),
  );
  for (const size of Object.keys(computerSizes))
    assert.deepEqual(
      boundedVmResources({
        ...computerSizeResources(size),
        diskGib: computerResourceBounds.diskGib,
        pidsMax: computerResourceBounds.pidsMax,
      }).vcpus,
      computerSizes[size].vcpus,
    );
  assert.throws(() => computerSizeResources("huge"));
  assert.throws(() => computerSizeResources("toString"));
});

test("host capacity weighs each size by its configured memory in 4 GiB units", () => {
  for (const [size, resources] of Object.entries(computerSizes))
    assert.equal(computerSizeUnits[size], resources.memoryMib / 4_096);
  assert.equal(unitsPerDefaultVm, computerSizeUnits.default);
});

test("the VM host refuses a larger Computer and an extended runtime", () => {
  const safe = {
    vcpus: 8,
    memMib: 16_384,
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
