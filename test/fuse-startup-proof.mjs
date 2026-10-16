/* global fetch, setTimeout, AbortSignal */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import console from "node:console";
import { proofImage } from "./proof-image.mjs";

const exec = promisify(execFile);
const image = await proofImage();
async function docker(...args) {
  return (await exec("docker", args, { timeout: 30_000 })).stdout.trim();
}
const container = await docker(
  "run",
  "-d",
  "--device",
  "/dev/fuse",
  "--cap-add",
  "SYS_ADMIN",
  "--security-opt",
  "apparmor=unconfined",
  "-p",
  "127.0.0.1::8080",
  "-p",
  "127.0.0.1::7681",
  image,
);
try {
  assert.equal(
    await docker(
      "exec",
      container,
      "find",
      "/",
      "-xdev",
      "-perm",
      "/6000",
      "-print",
    ),
    "",
    "the image must contain no setuid or setgid files",
  );
  const address = (await docker("port", container, "8080/tcp")).split("\n")[0];
  const terminalAddress = (await docker("port", container, "7681/tcp")).split(
    "\n",
  )[0];
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ready = await Promise.all(
      [address, terminalAddress].map((endpoint) =>
        fetch(`http://${endpoint}/health`, {
          signal: AbortSignal.timeout(1_000),
        }).then(
          (response) => response.ok,
          () => false,
        ),
      ),
    );
    if (ready.every(Boolean)) break;
    assert.equal(
      await docker("inspect", container, "--format", "{{.State.Running}}"),
      "true",
      "computerd exited before FUSE was ready",
    );
    assert.ok(
      Date.now() < deadline,
      "computerd never became ready with /dev/fuse present",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = JSON.parse(
    await docker(
      "exec",
      container,
      "node",
      "--input-type=module",
      "-e",
      `
    import fs from 'node:fs';
    const processes = fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).flatMap(p=>{
      try {
        const command=fs.readFileSync('/proc/'+p+'/cmdline','utf8');
        if (!command.includes('/opt/fungi/computerd.cjs') && !command.includes('/opt/fungi/computer-init.mjs') && !command.includes('/opt/fungi/terminal-runtime.mjs')) return [];
        if (command.includes('--input-type=module')) return [];
        const status=fs.readFileSync('/proc/'+p+'/status','utf8');
        return [{uid:Number(status.match(/^Uid:\\s+(\\d+)/m)[1]), noNewPrivs:Number(status.match(/^NoNewPrivs:\\s+(\\d+)/m)[1]), limits:fs.readFileSync('/proc/'+p+'/limits','utf8')}];
      } catch { return []; }
    });
    console.log(JSON.stringify({processes,mounts:fs.readFileSync('/proc/mounts','utf8')}));
  `,
    ),
  );
  assert.equal(
    state.processes.length,
    3,
    "supervisor, computerd, and exec’d Terminal must survive startup",
  );
  for (const runtime of state.processes) {
    assert.ok(
      runtime.uid >= 100_000,
      "runtime work must run as the Computer's own UID",
    );
    assert.equal(
      runtime.noNewPrivs,
      1,
      "runtime work must not gain privileges",
    );
    assert.match(runtime.limits, /Max processes\s+256\s+256/);
  }
  assert.match(
    state.mounts,
    /\S+ \/workspace fuse\S* /,
    "the workspace must use kernel FUSE",
  );
  console.log(
    "FUSE mounts before computerd and Terminal enter the unprivileged runtime phase",
  );
} finally {
  await docker("rm", "-f", container);
}
