/* global AbortSignal, fetch, setTimeout, clearTimeout */
// One way for every Computer runtime proof to start and stop its Worker.
//
// By default the proof Worker runs under `wrangler dev` with the platform
// container (wrangler.test.jsonc). `COMPUTER_PROOF_RUNTIME=celld` runs the
// same Worker source under `celld dev` instead, with the container backing
// placed in an on-box VM: the caller supplies COMPUTER_PROOF_CELLD (the celld
// binary), COMPUTER_PROOF_PORT (the Worker port computer-vmd forwards to),
// and the seam configuration of a running computer-vmd: COMPUTER_VM_HOSTS,
// COMPUTER_VM_SIGNING_KEY and COMPUTER_VM_DEFAULT_HOST.
// See tooling/celld-platform/computer-vm/.
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { z } from "zod";
import { installProofContainerTrap } from "../../../tooling/proof-containers/proof-janitor.mjs";
import { scaledBudgetMs } from "../../../tooling/repository/scripts/proof-budget.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtime = z
  .enum(["wrangler", "celld"])
  .parse(process.env.COMPUTER_PROOF_RUNTIME ?? "wrangler");
const proofOwner =
  runtime === "wrangler"
    ? installProofContainerTrap("computer-runtime")
    : undefined;
const loopbackAddress = z.object({ port: z.number().int().min(1).max(65_535) });

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is required when COMPUTER_PROOF_RUNTIME=celld`);
  return value;
}

async function selectPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const parsed = loopbackAddress.safeParse(server.address());
      if (!parsed.success) {
        reject(new Error("Could not select a loopback port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolve(parsed.data.port),
      );
    });
  });
}

/**
 * The celld project: wrangler.test.jsonc without the platform container.
 * celld requires `main` inside the project, so the package is linked in.
 */
async function writeCelldProject(directory, main, hosted) {
  await symlink(packageRoot, join(directory, "package"), "dir");
  await writeFile(
    join(directory, "wrangler.json"),
    JSON.stringify({
      name: "botanical-computer-runtime-proof",
      main: `package/${main}`,
      compatibility_date: "2026-09-04",
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
      durable_objects: {
        bindings: [{ name: "COMPUTER", class_name: "ComputerDO" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ComputerDO"] }],
    }),
  );
  if (!hosted) return;
  await writeFile(
    join(directory, ".dev.vars"),
    [
      `COMPUTER_VM_HOSTS='${required("COMPUTER_VM_HOSTS")}'`,
      `COMPUTER_VM_SIGNING_KEY=${required("COMPUTER_VM_SIGNING_KEY")}`,
      `COMPUTER_VM_DEFAULT_HOST=${required("COMPUTER_VM_DEFAULT_HOST")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

function spawnRuntime(persistence, port, wranglerConfig) {
  if (runtime === "celld")
    return spawn(
      required("COMPUTER_PROOF_CELLD"),
      ["dev", persistence, "--port", String(port), "--no-watch"],
      {
        cwd: persistence,
        detached: true,
        env: {
          ...process.env,
          CELLD_ESBUILD:
            process.env.CELLD_ESBUILD ??
            join(repositoryRoot, "node_modules/.bin/esbuild"),
          CELLD_READY_FLEET_GATE_MS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  return spawn(
    join(repositoryRoot, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      wranglerConfig,
      // Container names derive from the Worker name; keep concurrent lanes apart.
      "--name",
      proofOwner.workerName,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--persist-to",
      persistence,
    ],
    {
      cwd: packageRoot,
      detached: true,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function proofPort(selectedRuntime, hosted) {
  if (selectedRuntime !== "celld" || !hosted) return await selectPort();
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .parse(required("COMPUTER_PROOF_PORT"));
}

async function probeProofWorker(baseUrl) {
  try {
    const response = await fetch(baseUrl, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.status === 404;
  } catch {
    return false;
  }
}

async function waitForProofWorker(server, baseUrl, selectedRuntime) {
  const deadline = proofDeadline(selectedRuntime);
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;
    if (await probeProofWorker(baseUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function proofDeadline(selectedRuntime) {
  return Date.now() + (selectedRuntime === "celld" ? 90_000 : 30_000);
}

function workerClosed(server) {
  return new Promise((resolve) => {
    if (
      (server.exitCode !== null || server.signalCode !== null) &&
      server.stdout.closed &&
      server.stderr.closed
    )
      resolve();
    else server.once("close", resolve);
  });
}

function killProofGroup(server, signal) {
  try {
    process.kill(-server.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForClosure(closed, budgetMs) {
  let timer;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Do not reopen the persisted store until the old process and its pipes close. */
export async function stopProofWorker(server, selectedRuntime) {
  const closed = workerClosed(server);
  killProofGroup(server, "SIGTERM");
  const grace = scaledBudgetMs(selectedRuntime === "celld" ? 10_000 : 3_000);
  if (await waitForClosure(closed, grace)) return;
  killProofGroup(server, "SIGKILL");
  if (!(await waitForClosure(closed, scaledBudgetMs(3_000))))
    throw new Error("Computer proof Worker did not close after SIGKILL");
}

/**
 * Proof Workers that share one persisted state across restarts.
 * @param {string} label names the proof in its temporary directory and errors
 * @param {{ main?: string, wranglerConfig?: string, hosted?: boolean }} [worker] the proof
 *   Worker module and its Wrangler config (the platform container variant)
 */
export async function proofWorkers(
  label,
  {
    main = "test/worker.ts",
    wranglerConfig = "wrangler.test.jsonc",
    hosted = true,
  } = {},
) {
  if (!hosted && runtime !== "celld")
    throw new Error("An unhosted light-shell proof requires celld");
  const persistence = await mkdtemp(join(tmpdir(), `botanical-${label}-`));
  if (runtime === "celld") await writeCelldProject(persistence, main, hosted);

  async function start() {
    // celld mode keeps one port so the VM supervisor's Worker origin stays valid.
    const port = await proofPort(runtime, hosted);
    const output = [];
    const server = spawnRuntime(persistence, port, wranglerConfig);
    server.stdout.on("data", (chunk) => output.push(String(chunk)));
    server.stderr.on("data", (chunk) => output.push(String(chunk)));
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    if (await waitForProofWorker(server, baseUrl, runtime))
      return { baseUrl, output, server };
    await stop({ server });
    throw new Error(
      `Computer ${label} Worker did not start under ${runtime}:\n${output.join("").slice(-4_000)}`,
    );
  }

  async function stop(worker) {
    await stopProofWorker(worker.server, runtime);
  }

  async function dispose() {
    await rm(persistence, { recursive: true, force: true });
  }

  return { runtime, persistence, start, stop, dispose };
}
