import { dirname } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { copyFile, cp } from "node:fs/promises";

// The package build copies Cordyceps' two image inputs: the computerd daemon
// and the native apply-patch engine's source, which the Dockerfile's builder
// stage compiles for the image's own platform. Oyster's App candidate builder
// (team-candidate-builder.mjs) is copied into dist/ by the image assembly step
// (scripts/assemble-image.mjs), which runs after this build and before the
// Dockerfile's COPY, not by this script.
await copyFile(
  new URL(import.meta.resolve("@fungi.computer/cordyceps/cli")),
  new URL("../dist/computerd.cjs", import.meta.url),
);
await cp(
  dirname(
    fileURLToPath(
      import.meta
        .resolve("@fungi.computer/cordyceps/native/apply-patch/compile.mjs"),
    ),
  ),
  fileURLToPath(new URL("../dist/apply-patch/", import.meta.url)),
  { recursive: true },
);
