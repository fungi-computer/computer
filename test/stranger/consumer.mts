import {
  attachedBackendId,
  hostedBackingSchema,
  routeComputerBackend,
  type AttachedBackend,
  type BackendRoute,
  type HostedBacking,
} from "@fungi.computer/computer/backing";
import {
  computerGrantSchema,
  type ComputerBackendsProjection,
  type ComputerGrant,
} from "@fungi.computer/computer/fleet/wire";
import {
  decideComputerEgress,
  type ComputerEgressDecision,
} from "@fungi.computer/computer/egress";

const backing: HostedBacking = hostedBackingSchema.parse({
  kind: "on-box-vm",
  hostId: "hel1",
});
const attached: AttachedBackend = backing;
const backendId: string = attachedBackendId(attached);
const route: BackendRoute = routeComputerBackend([attached], () => false, {
  need: "hosted",
  backend: backendId,
});
const projection: ComputerBackendsProjection = {
  computerId: "stranger-computer",
  revision: 1,
  backends: [attached],
};
const grant: ComputerGrant = computerGrantSchema.parse({
  computerId: projection.computerId,
  actions: new Set(["files.read"]),
  expiresAt: 123,
  provenance: { actor: "stranger-host" },
});
const actions: ReadonlySet<string> = grant.actions;
const egress: ComputerEgressDecision = decideComputerEgress(
  { method: "GET" },
  new URL("https://oyster.test/settings"),
);
void { route, projection, actions, egress };
