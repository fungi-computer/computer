// The Computer image assembly step. This package's own `build` copies
// Cordyceps' daemon and native apply-patch engine into dist/
// (scripts/copy-daemon.mjs); this step copies the other file
// packages/computer/Dockerfile expects there: Oyster's App candidate builder
// (public, @fungi.computer/oyster's dist/build). It runs after
// `@fungi.computer/oyster#build` and this package's `build`, and before any
// `docker build` of the Dockerfile (turbo.jsonc:
// "@fungi.computer/computer#assemble:image"); `prepack` runs it too.
import { copyFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import console from "node:console";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");

const candidateBuilder = {
  from: resolve(repositoryRoot, "packages/oyster/dist/build/candidate-cli.mjs"),
  to: resolve(
    repositoryRoot,
    "packages/computer/dist/team-candidate-builder.mjs",
  ),
};

export async function assembleComputerImage() {
  const { from, to } = candidateBuilder;
  const sourceStat = await stat(from).catch((cause) => {
    throw new Error(
      `Computer image assembly is missing a build input: ${from} (build it first, e.g. "turbo run build --filter=@fungi.computer/oyster"). Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  });
  if (!sourceStat.isFile())
    throw new Error(`Computer image assembly input is not a file: ${from}`);
  await copyFile(from, to);
  console.error(`computer image assembly: copied ${from} -> ${to}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await assembleComputerImage();
}
