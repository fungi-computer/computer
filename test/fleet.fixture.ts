import { DurableObject } from "cloudflare:workers";
import {
  checkComputerGrant,
  createFleetBacking,
  computerFactSchema,
  type ComputerGrant,
  type ComputerFact,
} from "../src/fleet/index.js";

export class FleetProof extends DurableObject {
  create() {
    const backing = createFleetBacking(this.ctx.storage);
    backing.ensure();
    const grant: ComputerGrant = {
      computerId: "one",
      actions: new Set(["exec"]),
      expiresAt: Date.now() + 60_000,
      provenance: { actor: "local-owner", via: "local-invocation" },
    };
    const fact: ComputerFact = computerFactSchema.parse({
      kind: "interval",
      computerId: grant.computerId,
      provenance: grant.provenance,
      runtimeId: "runtime-one",
      backing: { kind: "platform-container" },
      startedAt: 1_000,
      observedAt: 2_000,
      ended: true,
    });
    return {
      admitted: checkComputerGrant(grant, {
        computerId: "one",
        action: "exec",
        now: Date.now(),
      }),
      refused: checkComputerGrant(grant, {
        computerId: "two",
        action: "exec",
        now: Date.now(),
      }),
      projection: backing.computerCreated("one", [
        { kind: "platform-container" },
      ]),
      fact,
    };
  }

  read() {
    const backing = createFleetBacking(this.ctx.storage);
    return backing.resolve("one");
  }
}

export default {
  async fetch(
    request: Request,
    env: { FLEET: DurableObjectNamespace<FleetProof> },
  ) {
    const path = new URL(request.url).pathname;
    const owner = env.FLEET.getByName("fleet-proof");
    if (path === "/create") return Response.json(await owner.create());
    if (path === "/read") return Response.json(await owner.read());
    return new Response(null, { status: 404 });
  },
};
