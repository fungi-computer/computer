import type {
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@fungi.computer/cloudflare-computer/backends/container";
import { z } from "zod";
import {
  SeamReplayGuard,
  importSeamSigner,
  importSeamVerifiers,
  seamBodyDigest,
  seamHeader,
  signSeamRequest,
  unsignedPayload,
  verifySeamRequest,
  type SeamSigner,
  type SeamVerifiers,
} from "@fungi.computer/seam";

/**
 * The on-box VM backing of a Computer's container.
 *
 * The container backing runs the unmodified Computer image (computerd plus
 * the terminal server) and speaks to it through the library's container host
 * seam, `IWorkspaceContainerAPI`. On Cloudflare that host is the platform
 * container. Here it is one Firecracker microVM that a host service
 * (`tooling/celld-platform/computer-vm/vmd.mjs`) runs on one of our own
 * machines. The Computer contract, its capabilities and the container
 * backend are unchanged; only the host behind the seam differs.
 *
 * Two doors cross the machine boundary, both mutually authenticated with
 * Ed25519 request signatures (`@fungi.computer/seam`):
 * - this Durable Object asks the host service to start, stop, inspect and
 *   intercept its VM and reaches the VM's ports through it (signed with the
 *   platform seam key the host pins);
 * - the host service forwards the VM's intercepted HTTP(S) to
 *   `/__computer-vm/<id>/…` on this Worker (signed with the host key this
 *   Worker pins in its host registry), which hands it to the same
 *   `WorkspaceProxy` entrypoint the platform container interception uses.
 */
export type OnBoxVmEnv = Readonly<{
  /** Public host registry: `{ hostId: { origin, publicKey } }` as JSON. */
  COMPUTER_VM_HOSTS?: string;
  /** Secret: `keyId:base64(pkcs8 Ed25519)`, the platform seam signing key. */
  COMPUTER_VM_SIGNING_KEY?: string;
  /** A standalone Computer Worker's host; Hub chooses per Computer instead. */
  COMPUTER_VM_DEFAULT_HOST?: string;
  /** Cloudflare Access service token for the host Tunnel. Both values are secrets. */
  COMPUTER_VM_ACCESS_CLIENT_ID?: string;
  COMPUTER_VM_ACCESS_CLIENT_SECRET?: string;
}>;

function accessHeaders(env: OnBoxVmEnv) {
  const id = env.COMPUTER_VM_ACCESS_CLIENT_ID;
  const secret = env.COMPUTER_VM_ACCESS_CLIENT_SECRET;
  if (id === undefined && secret === undefined) return {};
  const pair = z.tuple([z.string(), z.string()]).safeParse([id, secret]);
  if (!pair.success)
    throw new OnBoxVmUnavailableError("access", 503, "incomplete Access token");
  return {
    "CF-Access-Client-Id": pair.data[0],
    "CF-Access-Client-Secret": pair.data[1],
  };
}

const hostIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const hostRegistrySchema = z.record(
  hostIdSchema,
  z.strictObject({
    origin: z
      .url({ protocol: /^https?$/ })
      .transform((value) => new URL(value).origin),
    publicKey: z.base64().length(44),
  }),
);
type HostRegistry = z.infer<typeof hostRegistrySchema>;

/** Where one Computer's VM runs: a host from the registry. Secret-free. */
export type OnBoxVmPlacement = Readonly<{ hostId: string; origin: string }>;

const registries = new Map<string, HostRegistry>();
function hostRegistry(env: OnBoxVmEnv): HostRegistry {
  const raw = env.COMPUTER_VM_HOSTS ?? "{}";
  let registry = registries.get(raw);
  if (registry === undefined) {
    registry = hostRegistrySchema.parse(JSON.parse(raw));
    registries.set(raw, registry);
  }
  return registry;
}

/** The registered host `hostId`, or `undefined` when this Worker has none. */
export function onBoxVmPlacement(
  env: OnBoxVmEnv,
  hostId: string | undefined,
): OnBoxVmPlacement | undefined {
  if (hostId === undefined) return undefined;
  const host = hostRegistry(env)[hostIdSchema.parse(hostId)];
  return host === undefined ? undefined : { hostId, origin: host.origin };
}

class OnBoxVmUnavailableError extends Error {
  constructor(operation: string, status: number, detail = "") {
    super(
      `On-box Computer VM ${operation} failed with HTTP ${String(status)}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "OnBoxVmUnavailableError";
  }
}

const signers = new Map<string, Promise<SeamSigner>>();
function seamSigner(env: OnBoxVmEnv): Promise<SeamSigner> {
  const secret = env.COMPUTER_VM_SIGNING_KEY;
  if (secret === undefined)
    return Promise.reject(
      new OnBoxVmUnavailableError("sign", 503, "no seam signing key"),
    );
  let signer = signers.get(secret);
  if (signer === undefined) {
    signer = importSeamSigner(secret);
    signers.set(secret, signer);
  }
  return signer;
}

const verifierSets = new Map<string, Promise<SeamVerifiers>>();
function hostVerifiers(env: OnBoxVmEnv): Promise<SeamVerifiers> {
  const raw = env.COMPUTER_VM_HOSTS ?? "{}";
  let verifiers = verifierSets.get(raw);
  if (verifiers === undefined) {
    verifiers = importSeamVerifiers(
      Object.fromEntries(
        Object.entries(hostRegistry(env)).map(([hostId, host]) => [
          hostId,
          host.publicKey,
        ]),
      ),
    );
    verifierSets.set(raw, verifiers);
  }
  return verifiers;
}

/** The audience a host service verifies: requests for this host only. */
const vmHostAudience = (hostId: string) => `computer-vm-host:${hostId}`;
/** The audience this Worker's ingress door verifies. */
const vmIngressAudience = "computer-vm-ingress";

const exitSchema = z.strictObject({
  reason: z.string().max(1_024),
  exitedAt: z.number().int().nonnegative(),
});
const vmStateSchema = z.strictObject({
  running: z.boolean(),
  runtimeId: z.string().min(1).max(128).nullable(),
  exit: exitSchema.nullable(),
});
export type OnBoxVmState = z.infer<typeof vmStateSchema>;
const vmInventorySchema = z.array(
  vmStateSchema.extend({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    name: z.string(),
    lastActive: z.number().int().nonnegative(),
  }),
);
export type OnBoxVmInventory = z.infer<typeof vmInventorySchema>;
const vmStartSchema = z.strictObject({
  runtimeId: z.string().min(1).max(128),
});

type VmOperation = "status" | "start" | "restart" | "destroy" | "intercept";

/** The host service's request bodies: a boot, or one interception to install. */
type VmRequestBody =
  | Readonly<Record<string, never>>
  | Readonly<{
      env: Record<string, string>;
      enableInternet: boolean;
      sleepAfterMs: number;
    }>
  | Readonly<{ host: string; workspace: WorkspaceRef }>
  | Readonly<{ all: true; token: string; workspace: WorkspaceRef }>;

function vmBodyBytes(body: VmRequestBody | undefined): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)),
  );
}

async function signedVmRequest(
  env: OnBoxVmEnv,
  placement: OnBoxVmPlacement,
  url: string,
  body: VmRequestBody | undefined,
): Promise<RequestInit> {
  const method = body === undefined ? "GET" : "POST";
  const bytes = vmBodyBytes(body);
  const headers = new Headers({
    ...accessHeaders(env),
    [seamHeader]: await signSeamRequest(
      await seamSigner(env),
      vmHostAudience(placement.hostId),
      method,
      url,
      await seamBodyDigest(bytes),
    ),
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return body === undefined
    ? { method, headers }
    : { method, headers, body: bytes };
}

/** One Durable Object's view of its microVM through the host service. */
export class OnBoxVmContainerHost implements IWorkspaceContainerAPI {
  readonly #placement: OnBoxVmPlacement;
  readonly #env: OnBoxVmEnv;
  readonly #vmId: string;
  readonly #sleepAfterMs: number;

  constructor(
    placement: OnBoxVmPlacement,
    env: OnBoxVmEnv,
    vmId: string,
    sleepAfterMs: number,
  ) {
    this.#placement = placement;
    this.#env = env;
    this.#vmId = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .parse(vmId);
    this.#sleepAfterMs = sleepAfterMs;
  }

  async #call<T>(
    operation: VmOperation,
    schema: z.ZodType<T>,
    body?: VmRequestBody,
  ): Promise<T> {
    const path = operation === "status" ? "" : `/${operation}`;
    const url = `${this.#placement.origin}/vms/${this.#vmId}${path}`;
    const response = await fetch(
      url,
      await signedVmRequest(this.#env, this.#placement, url, body),
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new OnBoxVmUnavailableError(operation, response.status, detail);
    }
    return schema.parse(await response.json());
  }

  async #boot(
    operation: "start" | "restart",
    env: Record<string, string>,
    enableInternet: boolean,
  ) {
    const started = await this.#call(operation, vmStartSchema, {
      env,
      enableInternet,
      sleepAfterMs: this.#sleepAfterMs,
    });
    return { runtimeId: started.runtimeId };
  }

  /** Signed host-wide inventory; includes VMs outside this Hub's directory. */
  async inventory(): Promise<OnBoxVmInventory> {
    const url = `${this.#placement.origin}/vms`;
    const response = await fetch(
      url,
      await signedVmRequest(this.#env, this.#placement, url, undefined),
    );
    if (!response.ok)
      throw new OnBoxVmUnavailableError("inventory", response.status);
    return vmInventorySchema.parse(await response.json());
  }

  start(env: Record<string, string>, enableInternet: boolean) {
    return this.#boot("start", env, enableInternet);
  }

  restart(env: Record<string, string>, enableInternet: boolean) {
    return this.#boot("restart", env, enableInternet);
  }

  /** Stop a VM whose metered checkpoint cannot be funded or delivered. */
  destroy(): Promise<{ ok: true }> {
    return this.#call("destroy", z.strictObject({ ok: z.literal(true) }), {});
  }

  /** The VM as the host service sees it now. */
  state(): Promise<OnBoxVmState> {
    return this.#call("status", vmStateSchema);
  }

  async status() {
    const { running, exit } = await this.state();
    return { running, exit };
  }

  async exitInfo() {
    return (await this.state()).exit;
  }

  /** Whether the VM is running now; the platform container answers from `ctx.container.running`. */
  async running(): Promise<boolean> {
    return (await this.state()).running;
  }

  async interceptOutboundHttp(host: string, workspace: WorkspaceRef) {
    await this.#call("intercept", z.strictObject({ ok: z.literal(true) }), {
      host,
      workspace,
    });
  }

  async interceptAllOutboundHttp(workspace: WorkspaceRef, token: string) {
    await this.#call("intercept", z.strictObject({ ok: z.literal(true) }), {
      all: true,
      token,
      workspace,
    });
  }

  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit) {
    return this.port(port).fetch(input, init);
  }

  /**
   * A guest port, reached through the host service: the VM has no address
   * this Worker can route to. The guest sees the logical authority the
   * caller named, as a platform container port does.
   */
  port(port: number): Fetcher {
    const target = z.number().int().min(1).max(65_535).parse(port);
    const fetcher: Fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const logical = new URL(request.url);
        const url = `${this.#placement.origin}/vms/${this.#vmId}/ports/${String(target)}${logical.pathname}${logical.search}`;
        const headers = new Headers(request.headers);
        for (const [key, value] of new Headers(accessHeaders(this.#env)))
          headers.set(key, value);
        headers.set("x-fungi-port-host", logical.host);
        headers.set(
          seamHeader,
          await signSeamRequest(
            await seamSigner(this.#env),
            vmHostAudience(this.#placement.hostId),
            request.method,
            url,
            unsignedPayload,
          ),
        );
        return fetch(new Request(url, new Request(request, { headers })));
      },
      connect: () => {
        throw new OnBoxVmUnavailableError(
          "connect",
          501,
          "raw TCP to an on-box VM port is not offered",
        );
      },
    };
    return fetcher;
  }
}

const ingressPath = /^\/__computer-vm\/([0-9a-f]{64})(\/.*)$/;
const egressUrlSchema = z.url({ protocol: /^https?$/ });
const ingressReplay = new SeamReplayGuard();

/** The Computer namespace the ingress door addresses by object id. */
export type ComputerObjects = Readonly<{
  idFromString: (id: string) => DurableObjectId;
  get: (id: DurableObjectId) => Readonly<{
    fetch: (request: Request) => Promise<Response>;
  }>;
}>;

/**
 * The host service's door into this Worker: a VM's intercepted request
 * reaches its Computer exactly as the platform container's interception
 * does through `WorkspaceProxy` (the `/ws` connect upgrade, or an egress
 * request carrying the workspace egress token and original URL). Returns
 * `undefined` for every other path so the caller's router continues.
 */
export function onBoxVmIngress(
  request: Request,
  env: OnBoxVmEnv,
  computers: ComputerObjects,
): Promise<Response> | undefined {
  const url = new URL(request.url);
  const match = ingressPath.exec(url.pathname);
  if (match === null) return undefined;
  const [, id = "", rest = "/"] = match;
  return verifiedVmIngress(request, env, computers, id, rest, url.search);
}

/** The verified host id of a signed ingress request, or undefined. */
async function ingressHost(
  request: Request,
  env: OnBoxVmEnv,
): Promise<string | undefined> {
  try {
    return await verifySeamRequest(
      await hostVerifiers(env),
      vmIngressAudience,
      request.method,
      request.url,
      request.headers.get(seamHeader),
      null,
      ingressReplay,
    );
  } catch (cause) {
    console.error("VM seam verification refused", cause);

    return undefined;
  }
}

function vmCallbackTarget(target: URL): Response | null {
  // WorkspaceProxy's health and callback routes are the only local paths.
  const callback = /^\/__workspace_connect\/([0-9a-f-]{36})\/(health|ws)$/.exec(
    target.pathname,
  );
  if (vmHealthRequest(target, callback))
    return new Response("ok\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  const callbackToken = vmCallbackToken(callback);
  if (callbackToken !== undefined) {
    target.pathname = "/ws";
    target.searchParams.set("token", callbackToken);
  }
  if (target.pathname !== "/ws")
    return new Response("not found", { status: 404 });
  return null;
}

function vmHealthRequest(
  target: URL,
  callback: RegExpExecArray | null,
): boolean {
  return target.pathname === "/health" || callback?.[2] === "health";
}

function vmCallbackToken(callback: RegExpExecArray | null): string | undefined {
  return callback?.[1];
}

function vmEgressTarget(
  target: URL,
  headers: Headers,
  token: string,
  url: string | null,
): void {
  headers.set("x-workspace-egress-token", token);
  headers.set("x-workspace-egress-url", egressUrlSchema.parse(url));
  target.pathname = "/ws";
  target.search = "";
}

async function verifiedVmIngress(
  request: Request,
  env: OnBoxVmEnv,
  computers: ComputerObjects,
  id: string,
  rest: string,
  search: string,
): Promise<Response> {
  const hostId = await ingressHost(request, env);
  if (hostId === undefined) return new Response(null, { status: 404 });
  const headers = new Headers(request.headers);
  headers.delete(seamHeader);
  const token = headers.get("x-computer-vm-egress-token");
  const egressUrl = headers.get("x-computer-vm-egress-url");
  headers.delete("x-computer-vm-egress-token");
  headers.delete("x-computer-vm-egress-url");
  const target = new URL(`${rest}${search}`, "http://computer.internal");
  if (token === null) {
    const response = vmCallbackTarget(target);
    if (response !== null) return response;
  } else vmEgressTarget(target, headers, token, egressUrl);
  // The Computer hands this to the backend of the host that signed it.
  target.pathname = `/__vm/${hostId}${target.pathname}`;
  const computer = computers.get(computers.idFromString(id));
  return computer.fetch(new Request(target, new Request(request, { headers })));
}
