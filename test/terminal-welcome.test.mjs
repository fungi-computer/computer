import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";

const assets = fileURLToPath(
  new URL("../container/terminal-assets/", import.meta.url),
);

test("command shells and sourced non-interactive startup produce no welcome", () => {
  assert.equal(
    execFileSync(
      "bash",
      ["--noprofile", "--norc", "-c", `. '${assets}bashrc'`],
      { encoding: "utf8" },
    ),
    "",
  );
});

test("prompt shows branch, dirty state, short cwd and the previous exit status without evaluating labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "fungi-prompt-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "juice"], { cwd: dir });
    writeFileSync(join(dir, "untracked"), "dirty");
    // Source the actual shell asset, adapting only its image paths for this host.
    const rc = readFileSync(join(assets, "bashrc"), "utf8").replaceAll(
      "/opt/fungi/terminal-assets/",
      assets,
    );
    const path = join(dir, "rc");
    writeFileSync(path, rc);
    const text = execFileSync(
      "bash",
      [
        "--noprofile",
        "--rcfile",
        path,
        "-i",
        "-c",
        "(exit 7); _FUNGI_UPDATE_PS1; printf '%s\\n' \"$PS1\"; true; _FUNGI_UPDATE_PS1; printf '%s\\n' \"$PS1\"",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          NO_COLOR: "1",
          FUNGI_COMPUTER_NAME: "Höme $(touch injected)",
          LC_ALL: "C",
        },
      },
    );
    assert.match(text, /✗ 7 .*@Höme \$\(touch injected\) \\W git:\(juice\) \*/);
    assert.match(text, /✓ .*git:\(juice\)/);
    assert.equal(
      execFileSync("bash", ["-c", "test ! -e injected"], { cwd: dir }).length,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
