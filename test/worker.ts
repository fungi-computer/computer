import { z } from "zod";
import { execRequestSchema } from "../src/operation-contract.js";

import {
  getWorkspace,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeExecHandle,
} from "@fungi.computer/cloudflare-computer";
import {
  ComputerDO as NativeComputerDO,
  ComputerOperationConflictError,
  ComputerRequestInvalidError,
  createComputerFilesPort,
  createWorkspaceFilesPort,
  isComputerReservedPort,
  onBoxVmIngress,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type ComputerNamespace,
  type ComputerRpc,
  type OnBoxVmEnv,
} from "../src/index.js";
import type { ProcessRuntime } from "../src/process-inventory.js";

export { WorkspaceProxy, WorkspaceServiceProxy };

export type AssertTrue<Value extends true> = Value;
export type IsAssignable<Source, Target> = [Source] extends [Target]
  ? true
  : false;
export type ProcessEventStream = Awaited<ReturnType<ProcessRuntime["getExec"]>>;
export type MaintainedEventStream = ReadableStream<
  WorkspaceRuntimeEvent<"utf8">
> &
  Disposable;
export type ArbitraryEventStream = ReadableStream<
  Readonly<{ name: string; code?: number }>
> &
  Disposable;

/** Compile-time proof for the process owner's maintained event contract. */
export type ProcessRuntimeEventContractProof = readonly [
  AssertTrue<
    IsAssignable<WorkspaceRuntimeExecHandle<"utf8">, ProcessEventStream>
  >,
  AssertTrue<IsAssignable<MaintainedEventStream, ProcessEventStream>>,
  AssertTrue<
    IsAssignable<ArbitraryEventStream, ProcessEventStream> extends false
      ? true
      : false
  >,
];

/** Test-only route into the protected host seam; production exposes no PTY URL. */
export class ComputerDO extends NativeComputerDO {
  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test-process-start" && request.method === "POST") {
      return Response.json(
        await this.startProcessAfterAcceptance(
          z.json().parse(await request.json()),
          () => undefined,
        ),
      );
    }
    if (url.pathname === "/test-operation" && request.method === "POST") {
      const appMethod = url.searchParams.has("appMethod");
      const abortAfter = z.coerce
        .number()
        .int()
        .min(1)
        .max(5_000)
        .optional()
        .parse(url.searchParams.get("abortAfterMs") ?? undefined);
      const cancellation = new AbortController();
      const timer =
        abortAfter === undefined
          ? undefined
          : setTimeout(() => {
              cancellation.abort(
                new DOMException("App execution wait expired", "TimeoutError"),
              );
            }, abortAfter);
      try {
        return Response.json(
          await this.executeOperationAfterAcceptance(
            execRequestSchema.parse(await request.json()),
            () => {
              if (url.searchParams.has("denyAcceptance"))
                throw new Error("Fixture execution acceptance refused");
            },
            appMethod ? "bash" : "exec",
            appMethod ? { maximumTimeMs: 45_000 } : undefined,
            appMethod ? cancellation.signal : undefined,
          ),
        );
      } catch (error) {
        const invalid =
          error instanceof z.ZodError ||
          error instanceof ComputerRequestInvalidError;
        const conflict = error instanceof ComputerOperationConflictError;
        return Response.json(
          { error: invalid ? "invalid" : conflict ? "conflict" : "failed" },
          { status: invalid ? 400 : conflict ? 409 : 500 },
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (
      url.pathname.startsWith("/test-operation-status/") &&
      request.method === "GET"
    ) {
      try {
        return Response.json(
          this.getOperationStatusAfterAcceptance(
            url.pathname.slice("/test-operation-status/".length),
            () => undefined,
          ),
        );
      } catch {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
    }
    if (url.pathname === "/test-fill-operations" && request.method === "POST") {
      const input = z
        .strictObject({ requestId: z.uuid() })
        .parse(await request.json());
      // Seed a full record set accepted outside the admission window.
      const acceptedAt = Date.now() - 10 * 60 * 1_000;
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS computer_operations (request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'succeeded', 'failed', 'unknown')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, output_expires_at INTEGER NOT NULL, output_json TEXT) STRICT",
      );
      this.state.storage.sql.exec("DELETE FROM computer_operations");
      // Offset the seed's 12 random version-field bits so no filler record
      // can reproduce the seed's own request ID.
      const seedBits = Number.parseInt(input.requestId.slice(15, 18), 16);
      for (let index = 0; index < 500; index += 1) {
        const requestId =
          index === 0
            ? input.requestId
            : `${input.requestId.slice(0, 15)}${((seedBits + index) % 0x1000).toString(16).padStart(3, "0")}${input.requestId.slice(18)}`;
        const createdAt = index === 0 ? acceptedAt - 1_000 : acceptedAt;
        this.state.storage.sql.exec(
          "INSERT INTO computer_operations (request_id, input_hash, status, created_at, updated_at, output_expires_at, output_json) VALUES (?, 'proof', 'succeeded', ?, ?, ?, NULL)",
          requestId,
          createdAt,
          createdAt,
          createdAt + 86_400_000,
        );
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/test-container-running") {
      const hosted = this.hostedRoute();
      return Response.json({
        running:
          hosted !== undefined && (await this.containerRunning(hosted.backing)),
      });
    }
    if (url.pathname === "/test-pty") {
      const principalKey = url.searchParams.get("principal") ?? "member-one";
      return await this.terminalAfterAcceptance(
        request,
        principalKey,
        () => undefined,
      );
    }
    const preview = /^\/test-port-preview\/(\d+)(\/.*)?$/.exec(url.pathname);
    if (preview !== null) {
      const port = Number(preview[1]);
      const path = preview[2] ?? "/";
      const serviceUrl = new URL("http://localhost");
      serviceUrl.pathname = path;
      serviceUrl.search = url.search;
      const previewRequest = new Request(serviceUrl, request);
      if (path === "/__proof_websocket_upgrade")
        previewRequest.headers.set("Upgrade", "websocket");
      return await this.portPreviewAfterAcceptance(
        port,
        previewRequest,
        () => undefined,
      );
    }
    return await super.fetch(request);
  }
}

type Env = OnBoxVmEnv &
  Readonly<{
    COMPUTER: ComputerNamespace &
      Pick<DurableObjectNamespace, "idFromString" | "get">;
  }>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const callInput = z.strictObject({
  capability: z.string().min(1),
  input: z.json(),
});
const replaceInput = z.strictObject({
  path: z.string().min(1),
  expectedContent: z.string(),
  content: z.string(),
});
const filesReadInput = z.strictObject({
  path: z.string().min(1),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(4).positive(),
});

function rejectedName(operation: Promise<unknown>): Promise<string> {
  return operation.then(
    () => "none",
    (cause: unknown) => (cause instanceof Error ? cause.name : String(cause)),
  );
}

async function assertCancelledReplace(computer: ComputerRpc): Promise<void> {
  let replacementCalls = 0;
  // SAFETY: this proof calls only the replacement path, whose sole Computer member is supplied below.
  const countedComputer = {
    async replaceFileIfUnchanged(
      input: Parameters<ComputerRpc["replaceFileIfUnchanged"]>[0],
    ) {
      replacementCalls += 1;
      return await computer.replaceFileIfUnchanged(input);
    },
  } as ComputerRpc;
  const port = createComputerFilesPort(countedComputer);
  const cancellation = new AbortController();
  cancellation.abort();
  const rejectionName = await rejectedName(
    port.replace(
      { path: "/never.txt", expectedContent: "before", content: "after" },
      {
        executionId: "cancelled-before-replace",
        deadlineAt: null,
        signal: cancellation.signal,
      },
    ),
  );
  if (rejectionName !== "AbortError") {
    throw new Error("Computer Files accepted an already-aborted replacement");
  }
  if (replacementCalls !== 0) {
    throw new Error(
      "Computer Files started an already-aborted replacement RPC",
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const onBoxVm = onBoxVmIngress(request, env, env.COMPUTER);
    if (onBoxVm !== undefined) return await onBoxVm;
    const computer = env.COMPUTER.getByName("proof-home");
    const url = new URL(request.url);
    if (url.pathname === "/binary-file") {
      const path = z.string().parse(url.searchParams.get("path"));
      if (request.method === "PUT") {
        if (request.body === null)
          return new Response("File body required", { status: 400 });
        using workspace = await getWorkspace(computer);
        await workspace.fs.writeFile(path, request.body);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const content = await computer.readFile({ path });
        if (url.searchParams.has("slow")) await wait(250);
        return new Response(content);
      }
    }
    if (url.pathname === "/files/write" && request.method === "PUT") {
      // Inkcap's path: the DO's own write method, not the `getWorkspace` stub.
      const path = z.string().parse(url.searchParams.get("path"));
      if (request.body === null)
        return new Response("File body required", { status: 400 });
      // SAFETY: the Cloudflare ambient Request type omits ReadableStream's
      // generic; this body is the HTTP request's raw Uint8Array chunks.
      const body = request.body as ReadableStream<Uint8Array>;
      await computer.writeFile({ path }, body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/capabilities" && request.method === "GET") {
      await assertCancelledReplace(computer);
      return Response.json(await computer.getCapabilities());
    }
    if (url.pathname === "/container-running") {
      // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL("/test-container-running", request.url), request),
      );
    }
    if (url.pathname === "/pty") {
      // SAFETY: This is a test Worker and `computer` is the RPC stub returned by the bound DO namespace.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL(`/test-pty${url.search}`, request.url), request),
      );
    }
    if (url.pathname === "/ports" && request.method === "GET") {
      return Response.json(await computer.listPorts());
    }
    if (url.pathname === "/ports/expose" && request.method === "POST") {
      const input = z
        .strictObject({ port: z.number() })
        .parse(await request.json());
      try {
        return Response.json(await computer.exposePort(input));
      } catch (error) {
        // Workers RPC keeps the message, not the ComputerPortReservedError class.
        if (
          isComputerReservedPort(input.port) &&
          error instanceof Error &&
          error.message.includes("is reserved")
        )
          return Response.json({ error: "port is reserved" }, { status: 400 });
        throw error;
      }
    }
    if (url.pathname === "/ports/unexpose" && request.method === "POST") {
      return Response.json(
        await computer.unexposePort(
          z.strictObject({ port: z.number() }).parse(await request.json()),
        ),
      );
    }
    if (url.pathname.startsWith("/port-preview/")) {
      // SAFETY: this is a test Worker calling the Computer DO's test-only fetch seam.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(
          new URL(
            `/test-port-preview/${url.pathname.slice("/port-preview/".length)}${url.search}`,
            request.url,
          ),
          request,
        ),
      );
    }
    if (url.pathname === "/host-process-start" && request.method === "POST") {
      // SAFETY: the fixture's named DO binding reaches its test-only protected host seam.
      const stub = computer as ComputerRpc & {
        fetch: (request: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL("/test-process-start", request.url), request),
      );
    }
    if (url.pathname === "/call" && request.method === "POST") {
      const input = callInput.parse(await request.json());
      return Response.json(await computer.call(input.capability, input.input));
    }
    if (url.pathname === "/test-fill-operations" && request.method === "POST") {
      // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(new URL("/test-fill-operations", request.url), request),
      );
    }
    if (url.pathname === "/operation" && request.method === "POST") {
      // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
      const stub = computer as ComputerRpc & {
        fetch: (input: Request) => Promise<Response>;
      };
      return await stub.fetch(
        new Request(
          new URL(`/test-operation${url.search}`, request.url),
          request,
        ),
      );
    }
    if (
      url.pathname.startsWith("/operation-status/") &&
      request.method === "GET"
    ) {
      try {
        // SAFETY: `computer` is the test Worker's named DO binding stub; its fetch is the test-only route to its own proof actor.
        const stub = computer as ComputerRpc & {
          fetch: (input: Request) => Promise<Response>;
        };
        return await stub.fetch(
          new Request(
            new URL(
              `/test-operation-status/${url.pathname.slice("/operation-status/".length)}`,
              request.url,
            ),
            request,
          ),
        );
      } catch {
        return Response.json({ error: "unavailable" }, { status: 500 });
      }
    }
    if (url.pathname === "/replace" && request.method === "POST") {
      return Response.json(
        await computer.replaceFileIfUnchanged(
          replaceInput.parse(await request.json()),
        ),
      );
    }
    if (url.pathname === "/files/read" && request.method === "POST") {
      using workspace = await getWorkspace(computer);
      const port = createWorkspaceFilesPort(workspace, computer);
      return Response.json(
        await port.read(filesReadInput.parse(await request.json())),
      );
    }
    if (url.pathname === "/files/replace" && request.method === "POST") {
      using workspace = await getWorkspace(computer);
      const port = createWorkspaceFilesPort(workspace, computer);
      return Response.json(
        await port.replace(replaceInput.parse(await request.json())),
      );
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
