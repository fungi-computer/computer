/* global fetch, setTimeout */
import assert from "node:assert/strict";
import process from "node:process";
import { z } from "zod";
import { proofWorkers } from "./proof-worker.mjs";
import { proofClient, proofFailure } from "./proof-client.mjs";

const portList = z.strictObject({ ports: z.array(z.number().int()) });
const portResult = z.strictObject({
  port: z.number().int(),
  exposed: z.boolean(),
});
const portRemovalResult = z.strictObject({
  port: z.number().int(),
  removed: z.boolean(),
});
const serviceReply = z.strictObject({
  method: z.string(),
  url: z.string(),
  host: z.string(),
  marker: z.string(),
  body: z.string(),
  receivedCredentialHeaders: z.array(z.string()),
});
const maximumExposedPorts = 64;
const reservedPorts = [7681, 8080];
const workers = await proofWorkers("computer-port-proof");
const startWorker = workers.start;
const stopWorker = workers.stop;
let worker;

const { json, call } = proofClient(() => worker);

async function expose(port) {
  return portResult.parse(
    await json("/ports/expose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    }),
  );
}

async function unexpose(port) {
  return portRemovalResult.parse(
    await json("/ports/unexpose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    }),
  );
}

async function preview(port, path, init) {
  return await fetch(
    `${worker.baseUrl}/port-preview/${String(port)}${path}`,
    init,
  );
}

const serviceSource = `
import { createServer } from "node:http";
const port = Number(process.argv[2]);
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  response.setHeader("content-type", "application/json");
  response.setHeader("set-cookie", "gateway=stolen; Domain=example.test");
  response.end(JSON.stringify({
    method: request.method,
    url: request.url,
    host: request.headers.host ?? "",
    marker: request.headers["x-proof-marker"] ?? "",
    receivedCredentialHeaders: ["authorization", "cookie", "proxy-authorization", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret", "x-authenticated-user", "x-auth-request-user", "x-user-id", "x-forwarded-user", "x-forwarded-email"].filter((name) => request.headers[name] !== undefined),
    body,
  }));
});
server.listen(port, "0.0.0.0");
`;

try {
  worker = await startWorker();
  const exposedPort = 20_000 + Math.floor(Math.random() * 20_000);
  const missingPort = exposedPort + 1;
  await call("mkdir", { path: "/workspace" });
  await call("write", {
    path: "/workspace/port-service.mjs",
    content: serviceSource,
  });
  await expose(exposedPort);

  const upgrade = await preview(exposedPort, "/__proof_websocket_upgrade");
  assert.equal(
    upgrade.status,
    400,
    "preview upgrades must be refused before forwarding",
  );
  assert.deepEqual(await upgrade.json(), {
    error: "preview WebSocket upgrades are not supported",
  });

  const denied = await preview(missingPort, "/private");
  assert.equal(denied.status, 404, "unexposed ports must not be proxied");
  await denied.body?.cancel();

  for (const reservedPort of reservedPorts) {
    const refused = await fetch(`${worker.baseUrl}/ports/expose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: reservedPort }),
    });
    assert.equal(
      refused.status,
      400,
      `reserved daemon port ${String(reservedPort)} must not be admitted`,
    );
    await refused.body?.cancel();
    const bypass = await preview(reservedPort, "/health");
    assert.equal(
      bypass.status,
      400,
      `reserved daemon port ${String(reservedPort)} must not be proxied`,
    );
    await bypass.body?.cancel();
  }
  assert.ok(
    portList
      .parse(await json("/ports"))
      .ports.every((port) => !reservedPorts.includes(port)),
    "reserved ports are never listed as previewable",
  );

  const started = await call("bash", {
    command: `node /workspace/port-service.mjs ${String(exposedPort)} >/tmp/port-service-${String(exposedPort)}.log 2>&1 </dev/null &`,
    cwd: "/workspace",
    timeoutMs: 10_000,
  });
  assert.equal(started.exitCode, 0, "the fixture server command must start");
  let served;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    served = await preview(exposedPort, "/assets/page?theme=night", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-proof-marker": "forwarded-header",
        authorization: "Bearer hub-secret",
        cookie: "hub-session=session-secret",
        "proxy-authorization": "Basic proxy-secret",
        "cf-access-jwt-assertion": "identity-secret",
        "cf-access-client-id": "access-client",
        "cf-access-client-secret": "access-secret",
        "x-authenticated-user": "authenticated-user",
        "x-auth-request-user": "auth-request-user",
        "x-user-id": "user-id",
        "x-forwarded-user": "member@example.test",
        "x-forwarded-email": "member@example.test",
      },
      body: "forwarded-body",
    });
    if (served.status === 200) break;
    await served.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(served, "preview request was attempted");
  if (served.status !== 200) {
    throw new Error(
      `exposed service did not respond: ${String(served.status)} ${await served.text()}`,
    );
  }
  const reply = serviceReply.parse(await served.json());
  assert.equal(reply.method, "POST");
  assert.equal(reply.url, "/assets/page?theme=night");
  assert.equal(reply.marker, "forwarded-header");
  assert.equal(reply.body, "forwarded-body");
  assert.deepEqual(reply.receivedCredentialHeaders, []);
  assert.equal(served.headers.get("set-cookie"), null);
  assert.ok(
    !reply.host.includes("127.0.0.1"),
    "caller Host must not select the target",
  );
  const authorityLikePath = await preview(
    exposedPort,
    "//outside.invalid/asset?theme=night",
  );
  assert.equal(authorityLikePath.status, 200);
  const authorityLikeReply = serviceReply.parse(await authorityLikePath.json());
  assert.equal(authorityLikeReply.url, "//outside.invalid/asset?theme=night");
  assert.ok(
    !authorityLikeReply.host.includes("outside.invalid"),
    "a service path must not select a different host",
  );

  const extraPorts = Array.from(
    { length: maximumExposedPorts - 1 },
    (_, index) => exposedPort + index + 2,
  );
  await Promise.all(extraPorts.map((port) => expose(port)));
  assert.equal(
    (await expose(exposedPort)).exposed,
    true,
    "expose must be idempotent at capacity",
  );
  const overflow = await fetch(`${worker.baseUrl}/ports/expose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: exposedPort + maximumExposedPorts + 2 }),
  });
  assert.equal(
    overflow.ok,
    false,
    "the Computer must enforce its 64-port bound",
  );
  await overflow.body?.cancel();
  assert.equal(
    portList.parse(await json("/ports")).ports.length,
    maximumExposedPorts,
  );
  await Promise.all(extraPorts.map((port) => unexpose(port)));

  const portsBeforeReconstruction = portList.parse(await json("/ports")).ports;
  assert.deepEqual(portsBeforeReconstruction, [exposedPort]);
  await stopWorker(worker);
  worker = await startWorker();

  const portsAfterReconstruction = portList.parse(await json("/ports")).ports;
  assert.deepEqual(
    portsAfterReconstruction,
    [exposedPort],
    "exposure metadata must survive Worker reconstruction",
  );
  const listenerAfterReconstruction = await preview(
    exposedPort,
    "/assets/page?theme=night",
    { method: "GET" },
  );
  let listenerStatus;
  if (listenerAfterReconstruction.status === 200) {
    const reopened = serviceReply.parse(
      await listenerAfterReconstruction.json(),
    );
    assert.equal(reopened.url, "/assets/page?theme=night");
    listenerStatus = "still-serving";
  } else {
    listenerStatus = `unavailable-${String(listenerAfterReconstruction.status)}`;
    assert.equal(
      listenerAfterReconstruction.status,
      502,
      "an exposed port without a listener must return 502",
    );
    await listenerAfterReconstruction.body?.cancel();
  }

  const noListener = await expose(missingPort);
  assert.equal(noListener.exposed, true);
  const absent = await preview(missingPort, "/");
  assert.equal(
    absent.status,
    502,
    "an exposed port with no listener must return 502",
  );
  await absent.body?.cancel();
  await unexpose(missingPort);
  const removed = await unexpose(exposedPort);
  assert.equal(removed.removed, true);
  assert.deepEqual(await unexpose(exposedPort), {
    port: exposedPort,
    removed: false,
  });
  const deniedAfterRemoval = await preview(exposedPort, "/");
  assert.equal(deniedAfterRemoval.status, 404);
  await deniedAfterRemoval.body?.cancel();

  process.stdout.write(
    `${JSON.stringify({ proof: "computer-port-admission-preview-reconstruction", verdict: "pass", listenerAfterReconstruction: listenerStatus })}\n`,
  );
} catch (error) {
  throw proofFailure(error, workers, worker);
} finally {
  if (worker) await stopWorker(worker);
  await workers.dispose();
}
