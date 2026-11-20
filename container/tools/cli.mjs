import process from "node:process";
import { installTool, ToolsInstallError } from "./install.mjs";
import { toolCatalog } from "./manifest.mjs";

// Created per Computer by computer-start.sh outside the synced /workspace home.
// It survives nothing across a wake; Agent CLIs are reinstalled from pins.
const cache = "/var/cache/fungi-tools";

const controller = new globalThis.AbortController();
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => controller.abort());

/** Run one install; resolve to the process exit status. */
async function main() {
  try {
    const [operation, tool, ...extra] = process.argv.slice(2);
    if (operation !== "install" || !tool || extra.length !== 0)
      throw new ToolsInstallError(
        "unsupported",
        `Usage: fungi-tools install <${Object.keys(toolCatalog).join("|")}>`,
      );
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new ToolsInstallError(
        "unsupported",
        "This image supports Linux x64 tools only",
      );
    if (!process.env.HOME || process.getuid() === 0)
      throw new ToolsInstallError(
        "unsupported",
        "Run as the Computer user with its durable HOME, not root",
      );
    const result = await installTool(tool, {
      home: process.env.HOME,
      cache,
      catalog: toolCatalog,
      signal: controller.signal,
      notify: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(
      `fungi-tools: ${result.tool} ${result.version}: ${result.status}\n`,
    );
    return { exitCode: 0 };
  } catch (cause) {
    const code =
      cause instanceof ToolsInstallError ? cause.code : "storage_failed";
    const message =
      cause instanceof ToolsInstallError
        ? cause.message
        : "Installation could not finish; check writable home and free space, then retry";
    process.stderr.write(`fungi-tools: ${code}: ${message}\n`);
    return { failure: code, exitCode: 1 };
  }
}

process.exitCode = (await main()).exitCode;
