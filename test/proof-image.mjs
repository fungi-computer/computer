import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

async function privateContext(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await privateContext(path);
    else if (entry.isFile()) await chmod(path, 0o600);
    else
      throw new Error(
        "Computer proof build context must contain ordinary files",
      );
  }
  await chmod(directory, 0o700);
}

/** An immutable image per proof; another checkout cannot replace its tag. */
export async function proofImage() {
  if (process.env.COMPUTER_IMAGE) return process.env.COMPUTER_IMAGE;
  const context = await mkdtemp(join(tmpdir(), "computer-image-proof-"));
  try {
    for (const name of ["Dockerfile", "container", "dist"])
      await cp(join(root, name), join(context, name), { recursive: true });
    // Reproduce the gate's private checkout modes. The real image must still
    // start Terminal and computerd after dropping to an unrelated runtime UID.
    await privateContext(context);
    const result = await exec("docker", ["build", "--quiet", context], {
      maxBuffer: 16 * 1_024 * 1_024,
    });
    return imageId.parse(result.stdout.trim());
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
