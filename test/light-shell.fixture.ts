import * as z from "zod";
import {
  ComputerDO as NativeComputerDO,
  type AttachedBackend,
  type ComputerEnv,
  type ComputerRpc,
} from "../src/index.js";

export { WorkspaceProxy, WorkspaceServiceProxy } from "../src/index.js";

/** A disposable Computer with no container or VM configured. */
export class ComputerDO extends NativeComputerDO {
  #hostedAdmissions = 0;

  protected override attachedBackends(): readonly AttachedBackend[] {
    return [];
  }

  protected override runOnBackend<T>(): Promise<T> {
    this.#hostedAdmissions += 1;
    return Promise.reject(
      new Error("This proof has no full execution backend"),
    );
  }

  hostedAdmissions(): number {
    return this.#hostedAdmissions;
  }

  async stateRoundTrip() {
    const workspace = await this.readyWorkspace();
    using first = await workspace.runtime.exec(
      "cd /workspace/sub && export A=1",
      { encoding: "utf8", timeoutMs: 30_000 },
    );
    const result = await first.result();
    if (result.state === undefined)
      throw new Error("The light result omitted shell state");
    using next = await workspace.runtime.exec('printf "%s:%s" "$PWD" "$A"', {
      encoding: "utf8",
      timeoutMs: 30_000,
      cwd: result.state.cwd,
      env: result.state.env,
    });
    return { first: result, next: await next.result() };
  }

  async stateEvents() {
    const workspace = await this.readyWorkspace();
    using run = await workspace.runtime.exec(
      "cd /workspace/sub && export A=1",
      { encoding: "utf8", timeoutMs: 30_000 },
    );
    const events = [];
    for await (const event of run) events.push(event);
    return events;
  }
}

const callSchema = z.strictObject({
  capability: z.string(),
  input: z.json(),
});

type Env = ComputerEnv & {
  COMPUTER: {
    getByName(name: string): Pick<ComputerRpc, "call"> & {
      hostedAdmissions(): Promise<number>;
      stateRoundTrip(): ReturnType<ComputerDO["stateRoundTrip"]>;
      stateEvents(): ReturnType<ComputerDO["stateEvents"]>;
    };
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const computer = env.COMPUTER.getByName("light-shell-proof");
    if (url.pathname === "/call" && request.method === "POST") {
      const input = callSchema.parse(await request.json());
      return Response.json(await computer.call(input.capability, input.input));
    }
    if (url.pathname === "/hosted-admissions")
      return Response.json({ count: await computer.hostedAdmissions() });
    if (url.pathname === "/state-round-trip")
      return Response.json(await computer.stateRoundTrip());
    if (url.pathname === "/state-events")
      return Response.json(await computer.stateEvents());
    return new Response("Not found", { status: 404 });
  },
};
