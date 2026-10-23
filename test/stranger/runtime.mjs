import assert from "node:assert/strict";
import { URL } from "node:url";
import {
  attachedBackendId,
  attachedBackendsSchema,
  hostedBackingSchema,
  routeComputerBackend,
} from "@fungi.computer/computer/backing";
import { decideComputerEgress } from "@fungi.computer/computer/egress";
import { computerGrantSchema } from "@fungi.computer/computer/fleet/wire";

// The documented Node entries must work outside the workspace without loading
// the Worker host. This does not start a Computer or prove container health.
const container = hostedBackingSchema.parse({ kind: "platform-container" });
const vm = hostedBackingSchema.parse({ kind: "on-box-vm", hostId: "hel1" });
assert.equal(attachedBackendId(vm), "vm-hel1");
assert.deepEqual(
  routeComputerBackend([container, vm], () => false, { need: "hosted" }),
  { kind: "routed", id: "vm-hel1", backend: vm },
);
assert.deepEqual(
  routeComputerBackend([container, vm], () => false, {
    need: "hosted",
    backend: "vm-missing",
  }),
  { kind: "backend_unavailable", id: "vm-missing" },
);
assert.equal(attachedBackendsSchema.safeParse([vm, vm]).success, false);

const grant = computerGrantSchema.parse({
  computerId: "stranger-computer",
  actions: new Set(["files.read"]),
  expiresAt: 123,
  provenance: { actor: "stranger-host" },
});
assert.equal(grant.computerId, "stranger-computer");
assert.equal(grant.actions.has("files.read"), true);
assert.equal(grant.actions.has("start"), false);

const host = {
  origin: "https://oyster.test",
  route: (_request, url) =>
    url.pathname.startsWith("/git/") ? { path: url.pathname } : null,
};
assert.deepEqual(
  decideComputerEgress(
    { method: "GET" },
    new URL("https://oyster.test/git/app/repo.git/info/refs"),
    host,
  ),
  { kind: "origin-git" },
);
assert.equal(
  decideComputerEgress(
    { method: "GET" },
    new URL("https://oyster.test/settings"),
    host,
  ).kind,
  "denied",
);
