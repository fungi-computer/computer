/* global fetch, setTimeout */
// Real-image proof of the guest sshd bridge (`/ssh` on the terminal port). It
// builds this Dockerfile, hands the container the files vmd will supply at boot
// (a user CA, this VM's principal and a host key), and drives the real `ssh`
// client through a ProxyCommand that pipes to `/ssh`. The only way in is a
// certificate signed by that CA whose principal is the VM id. It fails if sshd
// falls back to authorized_keys, ignores the principal, honours an expired
// certificate, forwards an agent, or listens on a socket of its own.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { proofImage } from "./proof-image.mjs";

const run = promisify(execFile);
const image = await proofImage();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pipe = fileURLToPath(new URL("ssh-websocket-pipe.mjs", import.meta.url));
const vmId = "ab".repeat(32);
const otherVmId = "cd".repeat(32);

async function docker(...args) {
  return (await run("docker", args, { maxBuffer: 16 * 1_024 * 1_024 })).stdout;
}

async function eventually(check, message, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(message);
    await delay(100);
  }
}

async function keygen(...args) {
  await run("ssh-keygen", ["-q", ...args]);
}

/** Start a Computer; `ssh` is the directory vmd's guest config would supply. */
async function start(ssh) {
  const container = (
    await docker(
      "run",
      "-d",
      ...(ssh === undefined ? [] : ["-v", `${ssh}:/run/fungi-vm/ssh:ro`]),
      "-p",
      "127.0.0.1::7681",
      image,
    )
  ).trim();
  const address = (await docker("port", container, "7681/tcp"))
    .trim()
    .split("\n")[0];
  await eventually(async () => {
    try {
      return (await fetch(`http://${address}/health`)).ok;
    } catch {
      return false;
    }
  }, "the terminal server never became healthy");
  return { container, address };
}

async function sessions(address) {
  return (await (await fetch(`http://${address}/sessions`)).json()).attached;
}

/** Processes in the container whose command line starts with `pattern` (grep -E). */
async function processes(container, pattern) {
  return Number(
    (
      await docker(
        "exec",
        container,
        "sh",
        "-c",
        `ps -eo args= | grep -cE '^${pattern}' || true`,
      )
    ).trim(),
  );
}

/** The HTTP status of a WebSocket upgrade to `/ssh`, without completing one. */
function upgradeStatus(address) {
  const [host, port] = address.split(":");
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host,
      port: Number(port),
      path: "/ssh",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
}

/** TCP ports something in the container listens on, read from /proc. */
async function listening(container) {
  const table = await docker(
    "exec",
    container,
    "sh",
    "-c",
    "cat /proc/net/tcp /proc/net/tcp6",
  );
  return [
    ...new Set(
      table
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .filter((columns) => columns[3] === "0A")
        .map((columns) => Number.parseInt(columns[1].split(":")[1], 16)),
    ),
  ].sort((a, b) => a - b);
}

function ssh(directory, address, options, command, environment = {}) {
  const args = [
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${join(directory, "known_hosts")}`,
    "-o",
    "HostKeyAlias=proof.computer.fungi",
    "-o",
    `ProxyCommand=node ${pipe} ws://${address}/ssh`,
    "-o",
    "ConnectTimeout=20",
    ...options,
    "fungi@proof.computer.fungi",
    ...command,
  ];
  const child = spawn("ssh", args, {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (result.stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (result.stderr += String(chunk)));
  const done = new Promise((resolve) =>
    child.once("exit", (code) => resolve({ ...result, code })),
  );
  return { child, done };
}

const identity = (key, certificate) => [
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "IdentityAgent=none",
  "-i",
  key,
  ...(certificate === undefined
    ? []
    : ["-o", `CertificateFile=${certificate}`]),
];

async function runProof(directory) {
  const guest = join(directory, "guest-ssh");
  await mkdir(guest);
  await keygen(
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "ca",
    "-f",
    join(directory, "ca"),
  );
  await keygen("-t", "ed25519", "-N", "", "-f", join(guest, "host_ed25519"));
  await writeFile(
    join(guest, "user_ca.pub"),
    await readFile(join(directory, "ca.pub")),
  );
  await writeFile(join(guest, "principals"), `${vmId}\n`);
  await chmod(join(guest, "host_ed25519"), 0o644);
  const hostKey = (
    await readFile(join(guest, "host_ed25519.pub"), "utf8")
  ).trim();
  await writeFile(
    join(directory, "known_hosts"),
    `proof.computer.fungi ${hostKey}\n`,
  );
  const key = join(directory, "user");
  await keygen("-t", "ed25519", "-N", "", "-f", key);
  const sign = async (name, principal, validity, extensions = []) => {
    const pub = join(directory, `${name}.pub`);
    await writeFile(pub, await readFile(`${key}.pub`));
    await keygen(
      "-s",
      join(directory, "ca"),
      "-I",
      `user:proof team:proof computer:proof login:${name}`,
      "-n",
      principal,
      "-V",
      validity,
      "-O",
      "clear",
      "-O",
      "permit-pty",
      "-O",
      "permit-port-forwarding",
      ...extensions.flatMap((extension) => ["-O", extension]),
      "-z",
      String(Date.now()),
      pub,
    );
    return join(directory, `${name}-cert.pub`);
  };
  const valid = await sign("valid", vmId, "-30s:+300s");
  const expired = await sign("expired", vmId, "20200101:20200102");
  // sshd's own config, not the certificate's extensions, must refuse -A.
  const agentCertificate = await sign("agent", vmId, "-30s:+300s", [
    "permit-agent-forwarding",
  ]);
  const foreign = await sign("foreign", otherVmId, "-30s:+300s");

  const { container, address } = await start(guest);
  try {
    const uid = (
      await docker("exec", container, "cat", "/opt/fungi/.computer-uid")
    ).trim();
    const portsBefore = await listening(container);
    assert.deepEqual(
      portsBefore.filter((port) => port === 22),
      [],
      "no sshd listens before a session",
    );

    // A valid certificate reaches the runtime user, in its home.
    const ok = await ssh(directory, address, identity(key, valid), [
      "echo ok; id -un; pwd",
    ]).done;
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, "ok\nfungi\n/workspace\n");

    // Everything else is refused with ssh's own authentication failure (255).
    const refusals = [
      ["expired certificate", identity(key, expired)],
      ["certificate for another VM id", identity(key, foreign)],
      ["a bare key with no certificate", identity(key)],
    ];
    for (const [name, options] of refusals) {
      const refused = await ssh(directory, address, options, ["echo ok"]).done;
      assert.equal(refused.code, 255, `${name}: ${refused.stderr}`);
      assert.ok(!refused.stdout.includes("ok"), name);
    }

    // sshd never falls back to the user's authorized_keys, so a bare key listed
    // there is still refused.
    await docker(
      "exec",
      "-u",
      uid,
      container,
      "sh",
      "-c",
      `mkdir -p -m 700 /workspace/.ssh && printf '%s\\n' '${(await readFile(`${key}.pub`, "utf8")).trim()}' > /workspace/.ssh/authorized_keys && chmod 600 /workspace/.ssh/authorized_keys`,
    );
    const fallback = await ssh(directory, address, identity(key), ["echo ok"])
      .done;
    assert.equal(
      fallback.code,
      255,
      `authorized_keys fallback: ${fallback.stderr}`,
    );

    // A forwarded agent never reaches the guest: -A is refused by sshd.
    const agentSocket = join(directory, "agent.sock");
    const agent = spawn("ssh-agent", ["-D", "-a", agentSocket], {
      stdio: "ignore",
    });
    try {
      await eventually(
        async () =>
          await run("ssh-add", [key], {
            env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
          }).then(
            () => true,
            () => false,
          ),
        "ssh-agent never accepted the key",
      );
      const forwarded = await ssh(
        directory,
        address,
        [
          "-A",
          "-o",
          "IdentitiesOnly=yes",
          "-i",
          key,
          "-o",
          `CertificateFile=${agentCertificate}`,
        ],
        ['echo "agent=[$SSH_AUTH_SOCK]"'],
        { SSH_AUTH_SOCK: agentSocket },
      ).done;
      assert.equal(forwarded.code, 0, forwarded.stderr);
      assert.equal(forwarded.stdout, "agent=[]\n");
    } finally {
      agent.kill("SIGTERM");
    }

    // The session counts as attached while it lives, and sshd runs as the
    // runtime user and listens on nothing.
    const held = ssh(directory, address, identity(key, valid), ["sleep 60"]);
    await eventually(
      async () => (await sessions(address)) === 1,
      "the SSH session was not counted in /sessions",
    );
    const owners = (
      await docker(
        "exec",
        container,
        "sh",
        "-c",
        'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in "sshd"*|"/usr/sbin/sshd"*) stat -c %u $p;; esac; done',
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(owners.length > 0, "an sshd process serves the session");
    assert.deepEqual(
      [...new Set(owners)],
      [uid],
      "sshd runs as the runtime user",
    );
    assert.deepEqual(await listening(container), portsBefore);
    held.child.kill("SIGTERM");
    await held.done;
    await eventually(
      async () => (await sessions(address)) === 0,
      "a closed SSH session still counted as attached",
    );
    assert.deepEqual(await listening(container), portsBefore);
    await eventually(
      async () => (await processes(container, "(/usr/sbin/)?sshd")) === 0,
      "an sshd outlived its session",
    );

    // Hanging up mid-command leaves nothing the session started: sshd gives a
    // command without a PTY a session of its own and ignores SIGTERM there.
    const command = ssh(directory, address, identity(key, valid), [
      "sleep 301",
    ]);
    await eventually(
      async () => (await processes(container, "sleep 301")) === 1,
      "the SSH command never started",
    );
    command.child.kill("SIGTERM");
    await command.done;
    await eventually(
      async () => (await processes(container, "sleep 301")) === 0,
      "a hung-up SSH command is still running",
    );
    await eventually(
      async () => (await processes(container, "(/usr/sbin/)?sshd")) === 0,
      "an sshd outlived a hung-up command",
    );

    // Adding sshd left no setuid or setgid file in the image, ssh-keysign
    // included: it is installed and its mode has no s bit.
    assert.equal(
      (
        await docker(
          "exec",
          container,
          "sh",
          "-c",
          "find / -xdev -type f \\( -perm -4000 -o -perm -2000 \\) 2>/dev/null; true",
        )
      ).trim(),
      "",
      "the image has a setuid or setgid file",
    );
    assert.match(
      (
        await docker(
          "exec",
          container,
          "stat",
          "-c",
          "%a",
          "/usr/lib/openssh/ssh-keysign",
        )
      ).trim(),
      /^[0-7]{3}$/u,
    );
  } finally {
    await docker("rm", "-f", container);
  }

  // A Computer whose boot supplied no SSH subtree (no CA) boots normally and
  // offers no SSH: /ssh answers 503. Both a missing directory and an empty one.
  const emptyGuest = join(directory, "empty-guest-ssh");
  await mkdir(emptyGuest);
  for (const [name, mount] of [
    ["no ssh directory", undefined],
    ["an empty ssh directory", emptyGuest],
  ]) {
    const bare = await start(mount);
    try {
      // start() returned only after /health answered, so the boot succeeded.
      if (mount === undefined)
        assert.equal(
          (
            await docker(
              "exec",
              bare.container,
              "sh",
              "-c",
              "test -e /run/fungi-vm/ssh && echo present || echo absent",
            )
          ).trim(),
          "absent",
          "the guest has no ssh subtree",
        );
      assert.equal(await upgradeStatus(bare.address), 503, name);
      assert.equal(await sessions(bare.address), 0, name);
    } finally {
      await docker("rm", "-f", bare.container);
    }
  }
  return `${JSON.stringify({
    proof: "computer-ssh-container",
    validCertificate: "ok",
    expired: 255,
    otherVm: 255,
    bareKey: 255,
    authorizedKeysFallback: 255,
    agentForwarded: false,
    sessionsCounted: true,
    hungUpCommandKilled: true,
    setuidFiles: 0,
    listeningUnchanged: true,
  })}\n`;
}

const directory = await mkdtemp(join(tmpdir(), "computer-ssh-proof-"));
try {
  process.stdout.write(await runProof(directory));
} finally {
  await rm(directory, { recursive: true, force: true });
}
