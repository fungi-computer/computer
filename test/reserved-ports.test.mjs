/* global console */
import assert from "node:assert/strict";
import {
  computerReservedPorts,
  ComputerPortReservedError,
  isComputerReservedPort,
} from "../dist/operation-contract.js";

// The terminal (7681) and computerd (8080) must never be previewable.
for (const port of [7681, 8080]) {
  assert.equal(isComputerReservedPort(port), true, `${String(port)} reserved`);
  assert.ok(computerReservedPorts.has(port));
}
// 3000 is an ordinary dev-server port now that no Sandbox daemon uses it.
for (const port of [1, 3000, 5173, 8000, 8081, 65_535]) {
  assert.equal(isComputerReservedPort(port), false, `${String(port)} open`);
}
const error = new ComputerPortReservedError(8080);
assert.equal(error.name, "ComputerPortReservedError");
assert.match(error.message, /is reserved/);
console.log(JSON.stringify({ proof: "computer-reserved-ports", ok: true }));
