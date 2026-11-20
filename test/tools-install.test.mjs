import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { installTool } from "../container/tools/install.mjs";

const run = promisify(execFile);
const installModule = new URL(
  "../container/tools/install.mjs",
  import.meta.url,
);

async function fixture(t) {
  const root = new URL("../../../.botanical/", import.meta.url);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(new URL("tools-test-", root));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const cache = join(directory, "cache");
  const source = join(directory, "source");
  await mkdir(home);
  await mkdir(cache);
  await mkdir(source);
  await writeFile(join(source, "sample"), "#!/bin/sh\necho installed\n", {
    mode: 0o755,
  });
  const archive = join(directory, "sample.tar.gz");
  await run("tar", ["-czf", archive, "-C", source, "."]);
  const bytes = await readFile(archive);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const tool = {
    version: "1.0.0",
    archives: [
      {
        url: `http://127.0.0.1:${server.address().port}/sample.tar.gz`,
        algorithm: "sha256",
        digest: createHash("sha256").update(bytes).digest("hex"),
        strip: 0,
      },
    ],
    bins: { sample: "sample" },
  };
  return { directory, home, cache, tool, requests: () => requests, server };
}

/** A cached Agent CLI fixture whose wrapper re-runs this installer after wake. */
async function cachedFixture(t) {
  const context = await fixture(t);
  // Like a Computer, keep the cache on a different filesystem from home, so
  // nothing may be renamed between them.
  const cache = await mkdtemp("/dev/shm/fungi-tools-cache-");
  t.after(() => rm(cache, { recursive: true, force: true }));
  context.cache = cache;
  const tool = { ...context.tool, title: "Sample CLI", persistence: "cache" };
  const catalog = join(context.directory, "catalog.json");
  await writeFile(catalog, JSON.stringify({ sample: tool }));
  const installer = join(context.directory, "installer.mjs");
  await writeFile(
    installer,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { installTool } from ${JSON.stringify(installModule.href)};
await installTool(process.argv[3], {
  home: ${JSON.stringify(context.home)},
  cache: ${JSON.stringify(context.cache)},
  catalog: JSON.parse(readFileSync(${JSON.stringify(catalog)}, "utf8")),
  installer: ${JSON.stringify(installer)},
  notify: (line) => process.stderr.write(line + "\\n"),
});
`,
    { mode: 0o755 },
  );
  const messages = [];
  const options = {
    home: context.home,
    cache: context.cache,
    catalog: { sample: tool },
    installer,
    notify: (line) => messages.push(line),
  };
  return { ...context, tool, options, messages };
}

test("a checksum mismatch refuses the download before any tool is published", async (t) => {
  const { home, tool } = await fixture(t);
  tool.archives[0].digest = "0".repeat(64);
  await assert.rejects(
    installTool("sample", { home, catalog: { sample: tool } }),
    { code: "verification_failed" },
  );
  await assert.rejects(readFile(join(home, ".local/bin/sample")), {
    code: "ENOENT",
  });
  const installed = join(home, ".local/share/fungi-tools/sample");
  assert.deepEqual(await readdir(installed), []);
});

test("an uncached offline install returns a typed download failure", async (t) => {
  const { home, tool, server } = await fixture(t);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    installTool("sample", { home, catalog: { sample: tool } }),
    { code: "download_failed" },
  );
  await assert.rejects(readFile(join(home, ".local/bin/sample")), {
    code: "ENOENT",
  });
});

test("repeat install is a no-download no-op and the installed command works offline", async (t) => {
  const { home, tool, requests, server } = await fixture(t);
  const options = { home, catalog: { sample: tool } };
  assert.equal((await installTool("sample", options)).status, "installed");
  assert.equal(
    (await run(join(home, ".local/bin/sample"))).stdout,
    "installed\n",
  );
  assert.equal(requests(), 1);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(
    (await installTool("sample", options)).status,
    "already_installed",
  );
  assert.equal(requests(), 1);
  assert.equal(
    (await run(join(home, ".local/bin/sample"))).stdout,
    "installed\n",
  );
});

test("an incomplete candidate is never published and leaves the previous tool usable", async (t) => {
  const { home, tool } = await fixture(t);
  await installTool("sample", { home, catalog: { sample: tool } });
  const next = {
    ...tool,
    version: "1.0.1",
    bins: { sample: "sample", companion: "missing-upstream-resource" },
  };
  await assert.rejects(
    installTool("sample", { home, catalog: { sample: next } }),
  );
  assert.deepEqual(
    await readdir(join(home, ".local/share/fungi-tools/sample")),
    ["1.0.0-linux-x64"],
  );
  assert.equal(
    (await run(join(home, ".local/bin/sample"))).stdout,
    "installed\n",
  );
  await assert.rejects(readFile(join(home, ".local/bin/companion")), {
    code: "ENOENT",
  });
});

test("cancellation removes staging and does not claim an installation", async (t) => {
  const { home, tool } = await fixture(t);
  await assert.rejects(
    installTool("sample", {
      home,
      catalog: { sample: tool },
      signal: globalThis.AbortSignal.abort(),
    }),
    { code: "cancelled" },
  );
  assert.deepEqual(
    await readdir(join(home, ".local/share/fungi-tools/sample")),
    [],
  );
});

test("an Agent CLI installs into the non-synced cache and keeps only a wrapper in home", async (t) => {
  const { home, cache, options, messages } = await cachedFixture(t);
  assert.equal((await installTool("sample", options)).status, "installed");
  assert.deepEqual(await readdir(join(cache, "sample")), ["1.0.0-linux-x64"]);
  assert.deepEqual(
    await readdir(join(home, ".local/share/fungi-tools/sample")),
    ["cache-record"],
  );
  assert.match(
    await readFile(join(home, ".local/bin/sample"), "utf8"),
    /^#!\/bin\/sh\n/u,
  );
  assert.equal(
    (await run(join(home, ".local/bin/sample"))).stdout,
    "installed\n",
  );
  assert.deepEqual(messages, []);
});

test("after a wake clears the cache, first use re-verifies and reinstalls with a one-time message", async (t) => {
  const { home, cache, options, requests } = await cachedFixture(t);
  await installTool("sample", options);
  await rm(cache, { recursive: true });
  await mkdir(cache);
  const first = await run(join(home, ".local/bin/sample"));
  assert.equal(first.stdout, "installed\n");
  assert.equal(first.stderr, "installing Sample CLI (one-time after wake)\n");
  assert.equal(requests(), 2);
  const second = await run(join(home, ".local/bin/sample"));
  assert.equal(second.stderr, "");
  assert.equal(requests(), 2);
});

test("an Agent CLI reinstall after wake still refuses a mismatched artifact", async (t) => {
  const { cache, tool, options } = await cachedFixture(t);
  await installTool("sample", options);
  await rm(cache, { recursive: true });
  await mkdir(cache);
  const changed = {
    ...tool,
    archives: [{ ...tool.archives[0], digest: "0".repeat(64) }],
  };
  await assert.rejects(
    installTool("sample", { ...options, catalog: { sample: changed } }),
    { code: "verification_failed" },
  );
  assert.deepEqual(await readdir(join(cache, "sample")), []);
});

test("Go and Rust style home tools persist across a wake without downloading", async (t) => {
  const { home, cache, tool, requests } = await fixture(t);
  const options = {
    home,
    cache,
    catalog: { sample: { ...tool, persistence: "home" } },
  };
  await installTool("sample", options);
  await rm(cache, { recursive: true });
  await mkdir(cache);
  assert.equal(
    (await installTool("sample", options)).status,
    "already_installed",
  );
  assert.equal(requests(), 1);
  assert.equal(
    (await run(join(home, ".local/bin/sample"))).stdout,
    "installed\n",
  );
});
