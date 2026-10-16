/** Give Workspace a stream handle while its remote stream is still resolving. */
export function workspaceStream<T>(
  remote: PromiseLike<ReadableStream<T>>,
): ReadableStream<T> {
  const reader = Promise.resolve(remote).then((stream) => stream.getReader());
  return new ReadableStream<T>({
    pull: async (controller) => {
      const current = await reader;
      try {
        const next = await current.read();
        if (next.done) {
          current.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (cause) {
        current.releaseLock();
        throw cause;
      }
    },
    cancel: async (reason) => {
      const current = await reader;
      try {
        await current.cancel(reason);
      } finally {
        current.releaseLock();
      }
    },
  });
}
