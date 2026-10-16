// The Computer image's only supervisor. tini is PID 1 and reaps orphans;
// this process owns computerd and the terminal server. It restarts neither:
// if either dies the container exits, the Containers monitor records the
// exit, and the Computer's container backend launches a fresh runtime.
import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { enterRuntimePhase } from "./runtime-privileges.mjs";
import { boundedRuntimeMs } from "./resource-bounds.mjs";

const computerd = "/opt/fungi/computerd.cjs";
const terminalPort = Number(process.env.COMPUTER_TERMINAL_PORT ?? "7681");
// computerd (cordyceps) drops its own privileges in-process, so it needs this
// module by path, not by name: it never names a sibling package. This
// supervisor is its only supplier, since it is the one process that knows
// where the container placed the privilege boundary.
const runtimePrivilegeModule = fileURLToPath(
  new URL("./runtime-privileges.mjs", import.meta.url),
);

function log(message, fields) {
  process.stderr.write(
    `${JSON.stringify({ component: "computer-init", message, ...fields })}\n`,
  );
}

let terminal;
const daemon = spawn(process.execPath, [computerd], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  env: {
    ...process.env,
    COMPUTER_RUNTIME_PRIVILEGE_MODULE: runtimePrivilegeModule,
  },
});
let stopping = false;
const maximumRuntimeMs = boundedRuntimeMs(process.env.COMPUTER_MAX_RUNTIME_MS);
setTimeout(() => {
  log("runtime deadline reached", { maximumRuntimeMs });
  stopping = true;
  terminal?.kill("SIGTERM");
  daemon.kill("SIGTERM");
  setTimeout(() => process.exit(0), 5_000).unref();
}, maximumRuntimeMs).unref();

daemon.once("exit", (code, signal) => {
  log("computerd exited", { code, signal, stopping });
  terminal?.kill("SIGTERM");
  // An unrequested exit is a failure even when computerd reports 0.
  process.exit(stopping ? (code ?? 0) : 1);
});
daemon.once("error", (error) => {
  log("computerd failed to start", { error: error.message });
  terminal?.kill("SIGTERM");
  process.exit(1);
});

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Computer mount phase timed out")),
      15_000,
    );
    const failed = () => {
      clearTimeout(timer);
      reject(new Error("Computer exited during its mount phase"));
    };
    daemon.once("exit", failed);
    daemon.once("error", failed);
    daemon.once("message", (message) => {
      clearTimeout(timer);
      daemon.off("exit", failed);
      daemon.off("error", failed);
      if (message?.type !== "runtime-unprivileged") {
        reject(new Error("Unexpected Computer mount result"));
        return;
      }
      daemon.disconnect();
      resolve();
    });
  });
  enterRuntimePhase();
  // exec the terminal runtime with the permanent UID/GID and no-new-privs
  // inherited. The mount daemon retains its live FUSE descriptor and VFS state.
  terminal = spawn(process.execPath, ["/opt/fungi/terminal-runtime.mjs"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: process.env,
  });
  terminal.once("exit", () => {
    daemon.kill("SIGTERM");
    process.exit(stopping ? 0 : 1);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Terminal startup timed out")),
      15_000,
    );
    terminal.once("error", reject);
    terminal.once("message", (message) => {
      clearTimeout(timer);
      if (message?.type !== "terminal-ready")
        return reject(new Error("Unexpected Terminal startup result"));
      terminal.disconnect();
      resolve();
    });
  });
  log("terminal listening", { port: terminalPort });
} catch (error) {
  daemon.kill("SIGTERM");
  throw new Error("Computer terminal failed to listen", { cause: error });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    stopping = true;
    terminal?.kill("SIGTERM");
    daemon.kill(signal);
  });
}
