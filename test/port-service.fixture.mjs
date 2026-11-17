import process from "node:process";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
const port = Number(process.argv[2]);
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  response.setHeader("content-type", "application/json");
  response.setHeader("set-cookie", "gateway=stolen; Domain=example.test");
  response.end(
    JSON.stringify({
      method: request.method,
      url: request.url,
      host: request.headers.host ?? "",
      marker: request.headers["x-proof-marker"] ?? "",
      receivedCredentialHeaders: [
        "authorization",
        "cookie",
        "proxy-authorization",
        "cf-access-jwt-assertion",
        "cf-access-client-id",
        "cf-access-client-secret",
        "x-authenticated-user",
        "x-auth-request-user",
        "x-user-id",
        "x-forwarded-user",
        "x-forwarded-email",
      ].filter((name) => request.headers[name] !== undefined),
      body,
    }),
  );
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.on("message", (message) => socket.send("echo:" + message.toString()));
});
server.listen(port, "0.0.0.0");
