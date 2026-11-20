import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Failures printed by fungi-tools without changing Computer's exec protocol. */
export class ToolsInstallError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "ToolsInstallError";
    this.code = code;
  }
}

// The pinned catalog contains individual archives below this ceiling. Bound
// transfers even when a server omits or lies about Content-Length.
const maximumArchiveBytes = 1024 * 1024 * 1024;

async function download(archive, destination, signal) {
  const hash = createHash(archive.algorithm);
  let bytes = 0;
  const response = await globalThis.fetch(archive.url, {
    signal,
  });
  if (!response.ok || response.body === null)
    throw new ToolsInstallError("download_failed", "Artifact download failed");
  await pipeline(
    response.body,
    new Transform({
      transform(chunk, _encoding, next) {
        bytes += chunk.length;
        if (bytes > maximumArchiveBytes)
          return next(
            new ToolsInstallError(
              "download_failed",
              "Artifact exceeds download limit",
            ),
          );
        hash.update(chunk);
        next(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (hash.digest("hex") !== archive.digest)
    throw new ToolsInstallError(
      "verification_failed",
      "Artifact checksum did not match",
    );
}

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Install a catalog selection. `persistence: "home"` tools (Go, Rust) live in
 * the synced durable home. `persistence: "cache"` tools (Agent CLIs, whose
 * binaries exceed the synced home's per-file bound) live in the non-synced
 * per-Computer cache; home keeps only a small record and wrapper that
 * reinstalls the same pinned, digest-verified artifact after a wake.
 */
export async function installTool(
  name,
  {
    home,
    cache,
    catalog,
    signal: cancellation,
    installer = "/usr/local/bin/fungi-tools",
    notify,
  },
) {
  const signal = globalThis.AbortSignal.any([
    globalThis.AbortSignal.timeout(600_000),
    ...(cancellation ? [cancellation] : []),
  ]);
  const tool = Object.hasOwn(catalog, name) ? catalog[name] : undefined;
  if (!tool)
    throw new ToolsInstallError("unsupported", `Unknown tool: ${name}`);
  const cached = tool.persistence === "cache";
  const record = join(home, ".local/share/fungi-tools", name);
  const parent = cached ? join(cache, name) : record;
  await mkdir(parent, { recursive: true });
  const destination = join(parent, `${tool.version}-linux-x64`);
  const fingerprint = createHash("sha256").update(JSON.stringify(tool));
  if (tool.recipe === "pnpm")
    fingerprint.update(
      await readFile(new URL("./pi/pnpm-lock.yaml", import.meta.url)),
    );
  const identity = fingerprint.digest("hex");
  const marker = join(destination, ".complete");
  const expose = () =>
    cached
      ? writeRecord(record, tool.version).then(() =>
          writeWrappers(home, destination, name, tool.bins, installer),
        )
      : linkBins(home, destination, tool.bins);
  try {
    if ((await readFile(marker, "utf8")) !== identity)
      throw new ToolsInstallError(
        "verification_failed",
        `Installed ${name} does not match this image's pin`,
      );
    for (const bin of Object.values(tool.bins))
      await access(join(destination, bin), constants.X_OK);
    await expose();
    return { status: "already_installed", tool: name, version: tool.version };
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  if (cached) {
    try {
      await access(join(record, "cache-record"));
      notify?.(`installing ${tool.title} (one-time after wake)`);
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  }
  const staging = await mkdtemp(join(parent, ".install-"));
  let downloads;
  try {
    downloads = await mkdtemp(join(tmpdir(), "fungi-tools-"));
    for (const [index, archive] of tool.archives.entries()) {
      try {
        await download(archive, join(downloads, `download-${index}`), signal);
      } catch (cause) {
        if (cause instanceof ToolsInstallError) throw cause;
        const code = ["ENOSPC", "EACCES", "EROFS", "EDQUOT"].includes(
          cause.code,
        )
          ? "storage_failed"
          : cause.name === "TimeoutError"
            ? "timeout"
            : "download_failed";
        throw new ToolsInstallError(
          code,
          `Cannot download ${name}; retry the install when network and storage are available`,
          cause,
        );
      }
    }
    const payload = join(staging, "payload");
    await mkdir(payload);
    for (const [index, archive] of tool.archives.entries()) {
      const extracted =
        tool.recipe === "rust"
          ? join(downloads, `component-${index}`)
          : payload;
      await mkdir(extracted, { recursive: true });
      await run(
        "tar",
        [
          "-xf",
          join(downloads, `download-${index}`),
          "-C",
          extracted,
          `--strip-components=${archive.strip}`,
          "--no-same-owner",
        ],
        { timeout: 300_000, signal },
      );
      if (tool.recipe === "rust")
        await run(
          "sh",
          [
            join(extracted, "install.sh"),
            `--prefix=${payload}`,
            "--disable-ldconfig",
          ],
          { timeout: 300_000, signal },
        );
    }
    if (tool.recipe === "pnpm") {
      for (const file of [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ])
        await copyFile(
          new URL(`./pi/${file}`, import.meta.url),
          join(payload, file),
        );
      try {
        await run(
          "pnpm",
          [
            "install",
            "--frozen-lockfile",
            "--prod",
            "--ignore-scripts",
            "--config.node-linker=hoisted",
            `--store-dir=${join(downloads, "store")}`,
          ],
          {
            cwd: payload,
            timeout: 300_000,
            signal,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (cause) {
        throw new ToolsInstallError(
          "download_failed",
          "Pinned pi dependencies could not be installed; check network and storage, then retry",
          cause,
        );
      }
    }
    for (const bin of Object.values(tool.bins))
      await access(join(payload, bin), constants.X_OK);
    await writeFile(join(payload, ".complete"), identity);
    await rename(payload, destination);
    await expose();
    return { status: "installed", tool: name, version: tool.version };
  } catch (cause) {
    if (signal.aborted)
      throw new ToolsInstallError(
        cancellation?.aborted ? "cancelled" : "timeout",
        "Installation stopped before completion; retry explicitly",
        cause,
      );
    if (cause instanceof ToolsInstallError) throw cause;
    throw new ToolsInstallError(
      "storage_failed",
      `Cannot prepare ${name}; check the artifact, writable home and free space, then retry`,
      cause,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (downloads) await rm(downloads, { recursive: true, force: true });
  }
}

async function linkBins(home, destination, bins) {
  const directory = join(home, ".local/bin");
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, ".links-"));
  try {
    for (const [name, path] of Object.entries(bins)) {
      const link = join(staging, name);
      await symlink(join(destination, path), link);
      await rename(link, join(directory, name));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Remember in the synced home that this Agent CLI was installed, so the next
 * wake's reinstall can say so. The cache is another filesystem: stage the
 * record beside its final name and rename within home.
 */
async function writeRecord(record, version) {
  await mkdir(record, { recursive: true });
  const staging = await mkdtemp(join(record, ".record-"));
  try {
    const pending = join(staging, "cache-record");
    await writeFile(pending, `${version}\n`);
    await rename(pending, join(record, "cache-record"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Small synced wrappers: run the cached CLI, or reinstall it first after a wake. */
async function writeWrappers(home, destination, name, bins, installer) {
  const directory = join(home, ".local/bin");
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, ".links-"));
  try {
    for (const [bin, path] of Object.entries(bins)) {
      const wrapper = join(staging, bin);
      const target = join(destination, path);
      await writeFile(
        wrapper,
        `#!/bin/sh
# fungi-tools wrapper: the pinned CLI lives in the non-synced Computer cache.
target=${quote(target)}
if [ ! -x "$target" ]; then
  ${quote(installer)} install ${quote(name)} >&2 || exit $?
fi
exec "$target" "$@"
`,
        { mode: 0o755 },
      );
      await rename(wrapper, join(directory, bin));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
