/* global WebSocket, Buffer */
// ProxyCommand for the SSH container proof: pipes this process's stdin and
// stdout to one WebSocket, as the Hub's SSH transport will. Binary frames only.
import process from "node:process";

const socket = new WebSocket(process.argv[2]);
socket.binaryType = "arraybuffer";
socket.addEventListener("open", () => {
  process.stdin.on("data", (chunk) => socket.send(chunk));
  process.stdin.on("end", () => socket.close());
});
socket.addEventListener("message", (event) => {
  if (event.data instanceof ArrayBuffer)
    process.stdout.write(Buffer.from(event.data));
});
socket.addEventListener("close", () => process.exit(0));
socket.addEventListener("error", () => process.exit(1));
