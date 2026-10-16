// The container backing's http-gateway egress, on whichever runtime the proof
// harness selects: every HTTP and HTTPS request the Computer's container makes
// reaches the Worker's egress binding (Hub's ComputerGitEgress; here a stand-in
// that echoes what it was asked), HTTPS included through the interception CA
// the Computer trusts at connect, and no other connection reaches its
// destination.
import assert from "node:assert/strict";
import process from "node:process";
import { z } from "zod";
import { proofWorkers } from "./proof-worker.mjs";
import { proofCall } from "./proof-client.mjs";

const gatewayReply = z.strictObject({
  gateway: z.literal("egress-proof"),
  method: z.string(),
  url: z.string(),
  gitProtocol: z.string().nullable(),
  body: z.string(),
  bodyLength: z.number().int(),
});
const execResult = z.object({
  status: z.string(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const workers = await proofWorkers("computer-egress-proof", {
  main: "test/egress-worker.ts",
  wranglerConfig: "wrangler.egress-test.jsonc",
});
let worker;

const call = (capability, input) => proofCall(worker, capability, input);

function reply(result, step) {
  try {
    return gatewayReply.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw new Error(
      `${step} did not reach the gateway: ${JSON.stringify(result)}`,
      {
        cause: error,
      },
    );
  }
}

async function bash(command) {
  const { output } = await call("bash", {
    command,
    cwd: "/workspace",
    timeoutMs: 60_000,
  });
  return execResult.parse(output);
}

try {
  worker = await workers.start();
  await call("mkdir", { path: "/workspace", recursive: true });

  const plain = await bash(
    "curl -sS -H 'Git-Protocol: version=2' 'http://git.team/acme/repo.git/info/refs?service=git-upload-pack'",
  );
  assert.equal(plain.exitCode, 0, JSON.stringify(plain));
  const plainReply = reply(plain, "HTTP");
  assert.equal(
    plainReply.url,
    "http://git.team/acme/repo.git/info/refs?service=git-upload-pack",
  );
  assert.equal(plainReply.gitProtocol, "version=2");

  const secure = await bash(
    "curl -sS -X POST --data-binary 0000 https://git.team/acme/repo.git/git-upload-pack",
  );
  assert.equal(secure.exitCode, 0, JSON.stringify(secure));
  const secureReply = reply(secure, "HTTPS");
  assert.equal(
    secureReply.url,
    "https://git.team/acme/repo.git/git-upload-pack",
  );
  assert.equal(secureReply.method, "POST");
  assert.equal(secureReply.body, "0000");

  const artifact = await bash(
    'node -e \'const body=Buffer.alloc(7*1024*1024,97);fetch("https://build.team.internal/vishnu/publish",{method:"POST",body,headers:{"content-length":String(body.length)},signal:AbortSignal.timeout(20000)}).then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exitCode=1})\'',
  );
  assert.equal(artifact.exitCode, 0, JSON.stringify(artifact));
  const artifactReply = reply(artifact, "large HTTPS artifact");
  assert.equal(artifactReply.bodyLength, 7 * 1024 * 1024);

  const multipart = await bash(
    'node -e \'const url="https://build.team.internal/vishnu/publish";const form=new FormData();form.set("root",new Blob(["{}"]));form.set("sha256:"+"a".repeat(64),new Blob([Buffer.alloc(13*1024*1024)]));const encoded=new Request(url,{method:"POST",body:form});encoded.arrayBuffer().then(body=>fetch(url,{method:"POST",headers:{"content-type":encoded.headers.get("content-type"),"content-length":String(body.byteLength)},body,signal:AbortSignal.timeout(20000)})).then(r=>r.text()).then(console.log).catch(e=>{console.error(e);process.exitCode=1})\'',
  );
  assert.equal(multipart.exitCode, 0, JSON.stringify(multipart));
  const multipartReply = reply(multipart, "multipart HTTPS artifact");
  assert.ok(multipartReply.bodyLength > 13 * 1024 * 1024);

  const elsewhere = await bash("curl -sS https://example.com/anything; echo");
  assert.equal(elsewhere.exitCode, 0, JSON.stringify(elsewhere));
  assert.equal(
    reply(elsewhere, "HTTPS elsewhere").url,
    "https://example.com/anything",
    "every HTTPS destination reaches the gateway, which decides",
  );

  // Other ports never reach their destination: the connection fails (the
  // on-box VM fence) or it too lands on the gateway (platform interception).
  const otherPort = await bash(
    "curl -sS --max-time 5 http://93.184.216.34:8080/other; rc=$?; echo; echo rc=$rc",
  );
  if (/rc=0$/m.test(otherPort.stdout))
    assert.equal(
      reply(
        { ...otherPort, stdout: otherPort.stdout.split("\n")[0] ?? "" },
        "other port",
      ).url,
      "http://93.184.216.34:8080/other",
    );
  const ssh = await bash(
    "timeout 5 bash -c 'exec 3<>/dev/tcp/github.com/22; head -c 4 <&3' 2>/dev/null; echo",
  );
  assert.doesNotMatch(ssh.stdout, /SSH-/, JSON.stringify(ssh));

  process.stdout.write(
    `${JSON.stringify({ proof: "computer-egress-gateway", verdict: "pass", runtime: workers.runtime, http: true, https: true, otherDestinationsUnreached: true })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${workers.runtime} output:\n${worker?.output.join("").slice(-4_000) ?? ""}\n`,
  );
  throw error;
} finally {
  if (worker) await workers.stop(worker);
  await workers.dispose();
}
