/* global console */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  boundedInteger,
  maximumSessions,
  maximumSshSessions,
  parseResize,
  sshHasRoom,
  ReplayRing,
} from "../container/terminal-protocol.mjs";

assert.deepEqual(parseResize('{"type":"resize","cols":120,"rows":40}'), {
  cols: 120,
  rows: 40,
});
for (const frame of [
  "not json",
  "null",
  "[]",
  '{"type":"input","cols":1,"rows":1}',
  '{"type":"resize","cols":1,"rows":40}',
  '{"type":"resize","cols":120,"rows":301}',
  '{"type":"resize","cols":"12x","rows":40}',
])
  assert.equal(parseResize(frame), null, frame);

// SSH has its own cap below the shared pool, so one member's transports cannot
// take every slot a Team's terminals need.
assert.ok(maximumSshSessions < maximumSessions);
assert.equal(sshHasRoom(0), true);
assert.equal(sshHasRoom(maximumSshSessions - 1), true);
assert.equal(sshHasRoom(maximumSshSessions), false);
assert.equal(sshHasRoom(maximumSessions), false);

assert.equal(boundedInteger(null, 2, 500, 80), 80);
assert.equal(boundedInteger("99999", 2, 500, 80), 80);
assert.equal(boundedInteger("132", 2, 500, 80), 132);

const ring = new ReplayRing(8);
ring.push(Buffer.from("abcd"));
ring.push(Buffer.from("efgh"));
ring.push(Buffer.from("ij"));
assert.equal(ring.snapshot().toString(), "cdefghij", "keeps the newest bytes");
ring.push(Buffer.from("0123456789"));
assert.equal(ring.snapshot().toString(), "23456789", "trims inside a chunk");
console.log(JSON.stringify({ proof: "computer-terminal-protocol", ok: true }));
