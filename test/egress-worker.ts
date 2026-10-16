// Egress proof Worker: the Computer runtime's own ComputerDO with a stand-in
// for Hub's ComputerEgress (the http-gateway egress binding). Every HTTP(S)
// request the Computer's container makes must arrive here, and nothing else
// may leave the VM.
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import {
  ComputerDO as NativeComputerDO,
  onBoxVmIngress,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type ComputerEnv,
  type ComputerNamespace,
  type OnBoxVmEnv,
} from "../src/index.js";

export { WorkspaceProxy, WorkspaceServiceProxy };

/** Stands in for ComputerEgress: records what the gateway was asked for. */
export class EgressGateway extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const bytes = await request.arrayBuffer();
    return Response.json({
      gateway: "egress-proof",
      method: request.method,
      url: request.url,
      gitProtocol: request.headers.get("Git-Protocol"),
      body: bytes.byteLength > 1_000 ? "" : new TextDecoder().decode(bytes),
      bodyLength: bytes.byteLength,
    });
  }
}

/** Hub's ComputerDO receives its gateway the same way: a loopback export. */
export type EgressState = DurableObjectState &
  Readonly<{
    exports: Readonly<{
      EgressGateway: LoopbackForExport<typeof EgressGateway>;
    }>;
  }>;
export class ComputerDO extends NativeComputerDO {
  constructor(ctx: EgressState, env: ComputerEnv) {
    super(ctx, { ...env, COMPUTER_EGRESS: ctx.exports.EgressGateway });
  }
}

type Env = OnBoxVmEnv &
  Readonly<{
    COMPUTER: ComputerNamespace &
      Pick<DurableObjectNamespace, "idFromString" | "get">;
  }>;
const callInput = z.strictObject({
  capability: z.string(),
  input: z.json(),
});

export default {
  async fetch(request, env): Promise<Response> {
    const onBoxVm = onBoxVmIngress(request, env, env.COMPUTER);
    if (onBoxVm !== undefined) return await onBoxVm;
    const url = new URL(request.url);
    if (url.pathname === "/call" && request.method === "POST") {
      const input = callInput.parse(await request.json());
      return Response.json(
        await env.COMPUTER.getByName("egress-proof").call(
          input.capability,
          input.input,
        ),
      );
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
