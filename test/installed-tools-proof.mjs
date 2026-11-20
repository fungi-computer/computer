import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { log } from "node:console";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Exercise the image tools as its real, unprivileged Computer user. */
export async function proveInstalledTools(container) {
  const user = [
    "exec",
    "--user",
    "fungi",
    "--env",
    "HOME=/workspace",
    "--env",
    "NPM_CONFIG_PREFIX=/workspace/.npm-global",
    "--env",
    "PNPM_HOME=/workspace/.local/share/pnpm",
    container,
  ];
  await run("docker", [
    ...user,
    "bash",
    "-lc",
    `
set -eu
test "$(id -u)" != 0
for tool in python3 uv uvx gh rg fungi-tools; do command -v "$tool"; done
for tool in go rustc cargo claude codex opencode pi; do
  if command -v "$tool"; then echo "unexpected eager tool: $tool" >&2; exit 1; fi
done
`,
  ]);
  const installations = {};
  const tools = {
    go: { title: "Go", root: "/workspace/.local/share/fungi-tools" },
    rust: { title: "Rust", root: "/workspace/.local/share/fungi-tools" },
    claude: {
      title: "Claude Code",
      root: "/var/cache/fungi-tools",
      run: "claude",
    },
    codex: { title: "Codex", root: "/var/cache/fungi-tools", run: "codex" },
    opencode: {
      title: "OpenCode",
      root: "/var/cache/fungi-tools",
      run: "opencode",
    },
    pi: { title: "pi", root: "/var/cache/fungi-tools", run: "pi" },
  };
  for (const tool of Object.keys(tools)) {
    const started = performance.now();
    const result = await run(
      "docker",
      [...user, "fungi-tools", "install", tool],
      {
        timeout: 660_000,
      },
    );
    assert.match(result.stdout, /: installed\n$/u);
    installations[tool] = { milliseconds: performance.now() - started };
    const repeated = await run("docker", [
      ...user,
      "fungi-tools",
      "install",
      tool,
    ]);
    assert.match(repeated.stdout, /: already_installed\n$/u);
  }
  // Exact installed bytes and the largest single file of each artifact, against
  // the synced home's 256 MiB per-file bound.
  const sizes = {};
  for (const [tool, { root }] of Object.entries(tools)) {
    const { stdout } = await run("docker", [
      ...user,
      "bash",
      "-c",
      `set -euo pipefail
dir=$(echo ${root}/${tool}/*-linux-x64)
test -d "$dir"
printf '%s %s %s\\n' "$(du -sb --apparent-size "$dir" | cut -f1)" "$(find "$dir" -type f -printf '%s %P\\n' | sort -n | tail -1)"`,
    ]);
    const [bytes, largestBytes, largestFile] = stdout.trim().split(" ");
    sizes[tool] = {
      root,
      bytes: Number(bytes),
      largestFile,
      largestBytes: Number(largestBytes),
      exceeds256MiB: Number(largestBytes) > 256 * 1024 * 1024,
    };
  }
  for (const [tool, { root }] of Object.entries(tools))
    if (root === "/var/cache/fungi-tools")
      await run("docker", [
        ...user,
        "bash",
        "-c",
        `test ! -e /workspace/.local/share/fungi-tools/${tool}/*-linux-x64 && test -f /workspace/.local/share/fungi-tools/${tool}/cache-record`,
      ]);
  // Simulated wake: the non-synced cache is gone; the synced home remains.
  await run("docker", [
    "exec",
    container,
    "bash",
    "-c",
    "find /var/cache/fungi-tools -mindepth 1 -delete",
  ]);
  const afterWake = {};
  for (const [tool, { title, run: command }] of Object.entries(tools)) {
    if (!command) continue;
    const started = performance.now();
    const { stderr } = await run(
      "docker",
      [...user, "bash", "-lc", `${command} --version`],
      { timeout: 660_000 },
    );
    assert.match(
      stderr,
      new RegExp(`^installing ${title} \\(one-time after wake\\)$`, "mu"),
    );
    afterWake[tool] = { milliseconds: performance.now() - started };
    const { stderr: again } = await run("docker", [
      ...user,
      "bash",
      "-lc",
      `${command} --version`,
    ]);
    assert.doesNotMatch(again, /one-time after wake/u);
  }
  const versions = [
    ["python3", "--version", /^Python 3\./u],
    ["uv", "--version", /^uv 0\.13\.8\b/u],
    ["go", "version", /^go version go1\.27\.4 /u],
    ["rustc", "--version", /^rustc 1\.100\.0 /u],
    ["cargo", "--version", /^cargo 1\.100\.0 /u],
    ["gh", "--version", /^gh version /u],
    ["rg", "--version", /^ripgrep /u],
    ["claude", "--version", /2\.1\.325/u],
    ["codex", "--version", /0\.169\.0/u],
    ["opencode", "--version", /2\.3\.0/u],
    ["pi", "--version", /1\.5\.2/u],
  ];
  const installed = {};
  for (const [tool, option, expected] of versions) {
    const { stdout } = await run(
      "docker",
      [...user, "bash", "-lc", `${tool} ${option}`],
      { timeout: 30_000 },
    );
    assert.match(stdout.trim(), expected, `${tool} version`);
    installed[tool] = stdout.trim().split("\n")[0];
  }
  // Compile and run small programs without downloading dependencies. This
  // catches missing standard libraries/linkers that --version cannot expose.
  await run(
    "docker",
    [
      ...user,
      "bash",
      "-lc",
      `
set -euo pipefail
test "$(id -u)" != 0
work=$(mktemp -d /workspace/tool-proof-XXXXXX)
trap 'rm -rf "$work"' EXIT
cd "$work"
uv venv --offline --python /usr/bin/python3 .venv
.venv/bin/python -c 'import sqlite3, ssl; assert sum(range(10)) == 45'
printf 'package main\nimport "fmt"\nfunc main() { fmt.Println("go-ready") }\n' > main.go
test "$(GOTOOLCHAIN=local GOPROXY=off go run main.go)" = go-ready
cargo new --offline --vcs none --name tool_proof rust
printf 'fn main() { println!("rust-ready"); }\n' > rust/src/main.rs
test "$(cargo run --offline --quiet --manifest-path rust/Cargo.toml)" = rust-ready
printf 'search-ready\n' > search.txt
rg --quiet '^search-ready$' search.txt
`,
    ],
    { timeout: 120_000 },
  );
  log(
    JSON.stringify({
      proof: "computer-installed-tools",
      installed,
      installations,
      afterWake,
      sizes,
      compiledOffline: true,
    }),
  );
}
