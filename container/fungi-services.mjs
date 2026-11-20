// fungi-services apply: render the declared services (JSON on stdin) into the
// s6 scan directory and tell s6 to look again. The Computer's lifecycle runs it
// after every wake and every declaration change; s6 does the supervising.
import { Buffer } from "node:buffer";
import console from "node:console";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  applyInputSchema,
  parseSvstat,
  planApply,
  tailLog,
} from "./services-render.mjs";

const run = promisify(execFile);

/** The scan directory is created by computer-start.sh for the Computer's UID. */
const scanDir =
  process.env.COMPUTER_SERVICES_DIR ?? "/var/cache/fungi-services";
const workspace = process.env.MOUNT_POINT ?? "/workspace";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Service directories now in the scan directory, with their current `run` text. */
async function existingServices() {
  const found = new Map();
  for (const entry of await readdir(scanDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const run = join(scanDir, entry.name, "run");
    found.set(entry.name, existsSync(run) ? await readFile(run, "utf8") : "");
  }
  return found;
}

/** s6-svc exits 111 when no supervisor listens, which is true of a service that never started. */
async function stopSupervisor(name) {
  try {
    await control(name, "-dx");
  } catch (error) {
    if (error.code !== 111) throw error;
  }
}

async function put(path, text, mode) {
  const temporary = `${path}.new`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}

// A stop is not done until the program is gone: wait for s6 to report the
// service down, so a caller that reads status next never sees a stopping one.
const stopWait = ["-wD", "-T", "10000"];
const controlFlags = {
  "-u": ["-u"],
  "-ut": ["-ut"],
  "-t": ["-t"],
  "-d": [...stopWait, "-d"],
  "-dx": [...stopWait, "-dx"],
};
const control = (name, command) =>
  run("s6-svc", [...controlFlags[command], join(scanDir, name)]);

async function apply(input) {
  const logRoot = join(scanDir, ".logs");
  await mkdir(logRoot, { recursive: true });
  const plan = planApply(input, await existingServices(), {
    workspace,
    logRoot,
  });
  for (const name of plan.remove) {
    // Stop the program and its supervisor before the directory goes.
    await stopSupervisor(name);
    // The exiting supervisor may still be writing its status files.
    await rm(join(scanDir, name), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  for (const file of plan.write) {
    const directory = join(scanDir, file.name);
    await mkdir(join(directory, "log"), { recursive: true });
    await put(join(directory, "run"), file.run, 0o755);
    await put(join(directory, "log", "run"), file.logRun, 0o755);
    if (file.down === null) await rm(join(directory, "down"), { force: true });
    else await writeFile(join(directory, "down"), file.down);
  }
  await run("s6-svscanctl", ["-an", scanDir]);
  for (const { name, command } of plan.control) await control(name, command);
  return plan;
}

/** Live state of every service s6 supervises, as JSON. */
async function status() {
  const services = {};
  for (const name of (await existingServices()).keys()) {
    const { stdout } = await run("s6-svstat", [
      "-o",
      "up,wantedup,pid,updownfor",
      join(scanDir, name),
    ]);
    services[name] = parseSvstat(stdout);
  }
  return { services };
}

/** The retained tail of one service's log. */
async function logs(name, lines) {
  const file = join(scanDir, ".logs", name, "current");
  return {
    name,
    ...tailLog(existsSync(file) ? await readFile(file, "utf8") : "", lines),
  };
}

const [operation, ...extra] = process.argv.slice(2);
const usage =
  "Usage: fungi-services apply < services.json | status | logs <name> <lines> | restart <name>\n";
const serviceName = /^[a-z][a-z0-9-]{0,31}$/u;
if (!(
  ((operation === "apply" || operation === "status") && extra.length === 0) ||
  (operation === "logs" &&
    extra.length === 2 &&
    serviceName.test(extra[0]) &&
    /^\d{1,4}$/u.test(extra[1])) ||
  (operation === "restart" && extra.length === 1 && serviceName.test(extra[0]))
)) {
  process.stderr.write(usage);
  process.exit(2);
}
try {
  if (operation === "apply") {
    const input = applyInputSchema.parse(JSON.parse(await readStdin()));
    const plan = await apply(input);
    process.stdout.write(
      `${JSON.stringify({ applied: plan.write.map(({ name }) => name), removed: plan.remove })}\n`,
    );
  } else if (operation === "status")
    process.stdout.write(`${JSON.stringify(await status())}\n`);
  else if (operation === "logs")
    process.stdout.write(
      `${JSON.stringify(await logs(extra[0], Number(extra[1])))}\n`,
    );
  else {
    // TERM ends the service and the supervisor, which wants it up, starts it again.
    await control(extra[0], "-t");
    process.stdout.write(`${JSON.stringify({ restarted: extra[0] })}\n`);
  }
} catch (error) {
  console.error("fungi-services:", error);
  process.exit(1);
}
