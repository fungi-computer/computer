import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import console, { log } from "node:console";
import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { proveServices } from "./services-container-proof.mjs";

const run = promisify(execFile);
const container = `fungi-services-proof-${String(Date.now())}`;
const image = container;
const scratch = await mkdtemp(join(tmpdir(), "services-proof-"));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// The same layers the image adds for services: Debian's s6, the two modules and
// the wrapper, zod from the container's own lockfile, and a runtime user. The
// full image proof is terminal-container-proof.mjs.
await cp(
  `${packageRoot}container/fungi-services.mjs`,
  join(scratch, "fungi-services.mjs"),
);
await cp(
  `${packageRoot}container/services-render.mjs`,
  join(scratch, "services-render.mjs"),
);
await cp(
  `${packageRoot}container/fungi-services`,
  join(scratch, "fungi-services"),
);
await cp(`${packageRoot}container/package.json`, join(scratch, "package.json"));
await cp(
  `${packageRoot}container/pnpm-lock.yaml`,
  join(scratch, "pnpm-lock.yaml"),
);
await writeFile(
  join(scratch, "Dockerfile"),
  `FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600
RUN apt-get update && apt-get install -y --no-install-recommends s6 procps tini && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 123456 --create-home --home-dir /workspace --shell /bin/sh fungi
WORKDIR /opt/fungi
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-fund --no-audit zod@4.4.3
COPY --chmod=644 fungi-services.mjs services-render.mjs ./
COPY --chmod=755 fungi-services /usr/local/bin/fungi-services
RUN install -d -m 0700 -o fungi -g fungi /var/cache/fungi-services
ENV COMPUTER_SERVICES_DIR=/var/cache/fungi-services
USER fungi
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["s6-svscan", "/var/cache/fungi-services"]
`,
);
try {
  await run("docker", ["build", "-q", "-t", image, scratch], {
    timeout: 600_000,
  });
  await run("docker", ["run", "-d", "--name", container, image]);
  const result = await proveServices(container);
  assert.deepEqual(result, { restartedWithin: "2s" });
  log(JSON.stringify({ proof: "computer-services", ok: true, ...result }));
} finally {
  for (const args of [
    ["rm", "-f", container],
    ["rmi", "-f", image],
  ])
    try {
      await run("docker", args);
    } catch (error) {
      console.error(error);
    }
  await rm(scratch, { recursive: true, force: true });
}
