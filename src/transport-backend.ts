import type { WorkspaceBackend } from "@fungi.computer/cloudflare-computer";
import { workspaceStream } from "./workspace-stream.js";

function transportBoundary(closed: Promise<void> | undefined) {
  let disconnected = false;
  void closed?.then(() => {
    disconnected = true;
  });
  return async <T>(operation: () => PromiseLike<T>): Promise<T> => {
    try {
      return await operation();
    } catch (cause) {
      if (disconnected) {
        // Workspace recognizes a closed WebSocket as a transport failure.
        // Its backend signal, not exception wording, establishes that state.
        throw new Error("WebSocket closed during Computer backend RPC", {
          cause,
        });
      }
      throw cause;
    }
  };
}

function transportStream<T>(
  source: ReadableStream<T>,
  transport: ReturnType<typeof transportBoundary>,
): ReadableStream<T> {
  const reader = source.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const next = await transport(() => reader.read());
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (cause) {
        reader.releaseLock();
        throw cause;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/** Adapt remote Computer transport failures to Workspace's existing recovery. */
export function computerTransportBackend(
  backend: WorkspaceBackend,
): WorkspaceBackend {
  const wrapped: WorkspaceBackend = {
    id: backend.id,
    type: backend.type,
    async connect(host) {
      const handle = await backend.connect(host);
      const transport = transportBoundary(handle.closed);
      const { sync, shell } = handle.rpc;
      return {
        ...handle,
        close: () => handle.close(),
        rpc: {
          sync: {
            push: (input) => transport(() => sync.push(input)),
            async fetchChanges(input) {
              const result = await transport(() => sync.fetchChanges(input));
              // Preserve the RPC envelope, including its transport disposer.
              result.stream = transportStream(result.stream, transport);
              return result;
            },
            watermarks: () => transport(() => sync.watermarks()),
            readEntry: (path) => transport(() => sync.readEntry(path)),
            hasObjects: (hashes) => transport(() => sync.hasObjects(hashes)),
            fetchObjects: (hashes) =>
              workspaceStream(
                transport(() =>
                  Promise.resolve(sync.fetchObjects(hashes)),
                ).then((stream) => transportStream(stream, transport)),
              ),
            pushObjects: (objects) =>
              transport(() => sync.pushObjects(objects)),
          },
          shell: {
            async exec(input) {
              const result = await transport(() => shell.exec(input));
              result.events = transportStream(result.events, transport);
              return result;
            },
            async getExec(input) {
              const result = await transport(() => shell.getExec(input));
              result.events = transportStream(result.events, transport);
              return result;
            },
            killExec: (input) => transport(() => shell.killExec(input)),
            disposeExec: (input) => transport(() => shell.disposeExec(input)),
          },
        },
      };
    },
  };
  if (backend.callable === undefined) return wrapped;
  return { ...wrapped, callable: backend.callable };
}
