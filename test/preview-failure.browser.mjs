/* global Headers, Request, fetch, getComputedStyle, document */
// A port preview of a stopped Computer: vmd's own refusal (the real
// `refusePort` and `pipeHttpRequest`) reaches the preview's reply step, and
// the browser sees a styled page in plain words, never raw upstream text.
// A guest's own reply still passes through untouched, even one that tries to
// carry vmd's refusal header.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { chromium } from "playwright";
import {
  pipeHttpRequest,
  refusePort,
  refuseSilentGuest,
} from "../../../tooling/celld-platform/computer-vm/vmd-proxy.mjs";
import { portPreviewReply } from "../dist/port-failure.js";

const shots = process.env.COMPUTER_PREVIEW_FAILURE_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

// A port nothing listens on: bind, read the number, close.
const closed = net.createServer();
const closedPort = await listen(closed);
closed.close();

// The guest's own server: a 502 of its own, with a forged refusal header.
const guest = http.createServer((_req, res) => {
  res
    .writeHead(502, {
      "content-type": "text/plain",
      "x-fungi-port-failure": "not_running",
    })
    .end("guest says bad gateway\n");
});
const guestPort = await listen(guest);

// vmd's port door, reduced to its routing: /asleep has no running VM.
const vmd = http.createServer((req, res) => {
  if (req.url.startsWith("/asleep")) return refusePort(res, 503, "not_running");
  const port = req.url.startsWith("/guest") ? guestPort : closedPort;
  pipeHttpRequest(
    http,
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: "/",
      headers: req.headers,
    },
    req,
    res,
    new Set(),
    refuseSilentGuest,
  );
});
const vmdPort = await listen(vmd);

// The Computer's preview step: forward to vmd, then answer through
// `portPreviewReply`, exactly as `portPreviewAfterAcceptance` does.
const preview = http.createServer(async (req, res) => {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2)
    headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
  const request = new Request(`http://localhost${req.url}`, { headers });
  const upstream = await fetch(`http://127.0.0.1:${vmdPort}${req.url}`, {
    headers,
  });
  const reply = await portPreviewReply(upstream, request, 5173);
  res.writeHead(reply.status, Object.fromEntries(reply.headers));
  res.end(Buffer.from(await reply.arrayBuffer()));
});
const base = `http://127.0.0.1:${String(await listen(preview))}`;

const browser = await chromium.launch({ headless: true });
try {
  for (const [path, status, title, detail] of [
    [
      "/asleep",
      503,
      "This Computer is asleep",
      "Start it from Fungi, then reload this page to see the preview.",
    ],
    [
      "/silent",
      502,
      "Nothing is answering on port 5173",
      "Start the server on this Computer, or check its port, then reload this page.",
    ],
  ])
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      const page = await browser.newPage({ viewport: { width, height } });
      const response = await page.goto(`${base}${path}`);
      assert.equal(response?.status(), status);
      await page.getByRole("heading", { name: title }).waitFor();
      await page.getByText(detail, { exact: true }).waitFor();
      const text = await page.locator("body").innerText();
      assert.ok(!text.includes("not running"), "no raw vmd text");
      assert.ok(!text.includes("not_running"), "no raw reason code");
      assert.ok(!text.includes("not_listening"), "no raw reason code");
      // The page is styled: the card has a border and the body a background.
      const styled = await page.evaluate(() => ({
        border: getComputedStyle(document.querySelector("main")).borderStyle,
        background: getComputedStyle(document.body).backgroundColor,
      }));
      assert.equal(styled.border, "solid");
      assert.notEqual(styled.background, "rgba(0, 0, 0, 0)");
      if (shots)
        await page.screenshot({
          path: `${shots}/preview${path}-${String(width)}.png`,
        });
      await page.close();
    }

  // A script's request gets the reason as data, with the same status.
  const script = await fetch(`${base}/asleep`, {
    headers: { "sec-fetch-dest": "empty" },
  });
  assert.equal(script.status, 503);
  assert.deepEqual(await script.json(), { error: "not_running" });

  // The guest's own 502 passes through; its forged header is stripped by vmd.
  const page = await browser.newPage();
  const own = await page.goto(`${base}/guest`);
  assert.equal(own?.status(), 502);
  assert.equal(
    (await page.locator("body").innerText()).trim(),
    "guest says bad gateway",
  );
  await page.close();
  console.log(
    "PASS Computer preview failure: an asleep or silent Computer shows a styled page in plain words; the guest's own reply passes",
  );
} finally {
  await browser.close();
  for (const server of [preview, vmd, guest]) server.close();
}
