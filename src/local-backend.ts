import { workspaceStream } from "./workspace-stream.js";
import type {
  BackendHandle,
  WorkspaceBackend,
} from "@fungi.computer/cloudflare-computer";
import { newWebSocketRpcSession } from "@fungi.computer/capnweb";
import {
  SeamReplayGuard,
  importSeamVerifiers,
  seamHeader,
  verifySeamRequest,
} from "@fungi.computer/seam";
import { attachedBackendId, type LocalBackend } from "./computer-backends.js";

/**
 * A member's machine as a Workspace backend.
 *
 * The machine runs the same `computerd` as the container image and dials out
 * to its Computer; there is no listener to reach. The Hub hands the accepted
 * WebSocket to this Computer, which parks it here. `connect()` opens a capnweb
 * session over the parked socket and returns the machine's `WorkspaceRPC` as a
 * `sync: "remote"` handle, exactly as the container backend returns its
 * `computerd`. With nothing parked the machine is offline and `connect()`
 * fails at once, so routing can move on.
 */
export class LocalBackendOfflineError extends Error {
  constructor(readonly backendId: string) {
    super(`Local Computer backend ${backendId} is offline`);
    this.name = "LocalBackendOfflineError";
  }
}

/**
 * The live dial-ins of one Computer, keyed by backend id. It outlives each
 * Workspace generation so a rebuild does not forget a connected machine.
 */
export class LocalBackendConnections {
  readonly #sockets = new Map<string, WebSocket>();
  readonly #connected: (id: string) => void;

  constructor(connected: (id: string) => void = () => undefined) {
    this.#connected = connected;
  }

  online(id: string): boolean {
    return this.#sockets.has(id);
  }

  socket(id: string): WebSocket | undefined {
    return this.#sockets.get(id);
  }

  /** Park a verified dial-in; a newer dial from the same device replaces it. */
  park(id: string, socket: WebSocket): void {
    this.close(id, "replaced by a newer connection");
    this.#sockets.set(id, socket);
    const forget = () => {
      if (this.#sockets.get(id) === socket) this.#sockets.delete(id);
    };
    socket.addEventListener("close", forget);
    socket.addEventListener("error", forget);
    this.#connected(id);
  }

  close(id: string, reason: string): void {
    const socket = this.#sockets.get(id);
    if (socket === undefined) return;
    this.#sockets.delete(id);
    socket.close(1000, reason);
  }

  /** Close every dial-in whose backend is no longer attached. */
  retain(attached: ReadonlySet<string>): void {
    for (const id of this.#sockets.keys())
      if (!attached.has(id)) this.close(id, "backend detached");
  }
}

type WorkspaceRpc = BackendHandle["rpc"];

export class LocalWorkspaceBackend implements WorkspaceBackend {
  readonly type = "fungi-local";
  readonly id: string;
  readonly #connections: LocalBackendConnections;

  constructor(backend: LocalBackend, connections: LocalBackendConnections) {
    this.id = attachedBackendId(backend);
    this.#connections = connections;
  }

  connect(): Promise<BackendHandle> {
    const socket = this.#connections.socket(this.id);
    if (socket === undefined)
      return Promise.reject(new LocalBackendOfflineError(this.id));
    const session = newWebSocketRpcSession<WorkspaceRpc>(socket);
    const closed = new Promise<void>((resolve) => {
      const settle = () => {
        resolve();
      };
      socket.addEventListener("close", settle, { once: true });
      socket.addEventListener("error", settle, { once: true });
      session.onRpcBroken(settle);
    });
    const rpc: WorkspaceRpc = {
      shell: session.shell,
      sync: {
        push: (input) => session.sync.push(input),
        fetchChanges: (input) => session.sync.fetchChanges(input),
        watermarks: () => session.sync.watermarks(),
        readEntry: (path) => session.sync.readEntry(path),
        hasObjects: (hashes) => session.sync.hasObjects(hashes),
        pushObjects: (objects) => session.sync.pushObjects(objects),
        // capnweb resolves a streamed RPC result asynchronously. Workspace
        // consumes a synchronous stream handle, so bridge one chunk per pull.
        fetchObjects: (hashes) =>
          workspaceStream(session.sync.fetchObjects(hashes)),
      },
    };
    return Promise.resolve({
      rpc,
      sync: "remote",
      closed,
      close: () => {
        try {
          session[Symbol.dispose]();
        } catch (cause) {
          console.error("Local Computer backend operation failed", cause);

          // The session already ended.
        }
        this.#connections.close(this.id, "Workspace closed");
        return Promise.resolve();
      },
    });
  }
}

/** The audience one attached local backend's dial-in is signed for. */
export function localBackendAudience(
  computerName: string,
  backendId: string,
): string {
  return `fungi-local-backend:${computerName}:${backendId}`;
}

const dialReplay = new SeamReplayGuard();

/**
 * Verify a machine's signed dial-in against the public key its attachment
 * pinned. The WebSocket upgrade carries no body, so it signs an unsigned
 * payload over the exact path.
 */
export async function verifyLocalBackendDial(
  request: Request,
  computerName: string,
  backend: LocalBackend,
): Promise<boolean> {
  try {
    await verifySeamRequest(
      await importSeamVerifiers({ [backend.deviceId]: backend.publicKey }),
      localBackendAudience(computerName, attachedBackendId(backend)),
      request.method,
      request.url,
      request.headers.get(seamHeader),
      null,
      dialReplay,
    );
    return true;
  } catch (cause) {
    console.error("Local Computer backend operation failed", cause);

    return false;
  }
}

/**
 * The public dial path: `/api/teams/:team/computers/:computer/backends/:id/connect`.
 * The Hub forwards it unchanged so the signature covers what the machine sent.
 */
export const localBackendDialPath =
  /^\/api\/teams\/([^/]+)\/computers\/([^/]+)\/backends\/(local-[a-z2-7]{16})\/connect$/;
