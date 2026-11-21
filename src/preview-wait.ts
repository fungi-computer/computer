import {
  declaredPortWaitSeconds,
  portPreviewFailure,
  portPreviewReply,
  portPreviewRefusal,
} from "./port-failure.js";

/** How long a preview waits for a declared service to open its port. */
export const declaredPortWaitMs = declaredPortWaitSeconds * 1_000;
const pollMs = 500;

/** A declared, enabled service that owns the previewed port. */
export type PreviewedService = Readonly<{ name: string; port: number }>;

/**
 * Forward one preview request. When an enabled declared service owns the port,
 * a closed port is the service still starting after a wake, so keep trying for
 * up to 20 s and then say which service never opened which port. A port no
 * service declares is answered at once, as is any request that cannot be
 * replayed (a body, or an upgrade): the host's refusal means it never reached
 * the guest, but a streamed body is already spent.
 */
export async function forwardPreviewWaitingForPort(options: {
  service: PreviewedService | undefined;
  request: Request;
  port: number;
  /** One try against the guest; throws when the Computer cannot be reached. */
  attempt: () => Promise<Response>;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}): Promise<Response> {
  const { service, request, attempt } = options;
  const now = options.now ?? (() => Date.now());
  const delay =
    options.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { port } = options;
  const replayable =
    service !== undefined &&
    request.body === null &&
    !request.headers.has("upgrade");
  const reply = (response: Response) =>
    portPreviewReply(response, request, port);
  if (!replayable) {
    const response = await attempt();
    return await reply(response);
  }
  const deadline = now() + declaredPortWaitMs;
  let last: Awaited<ReturnType<typeof tryOnce>> | undefined;
  for (;;) {
    last = await tryOnce(attempt);
    if (last.ok) {
      if (portPreviewRefusal(last.response, request) !== "not_listening")
        return await reply(last.response);
      await last.response.body?.cancel();
    }
    // A failed try is the Computer unreachable this time: it may be mid-start.
    if (now() >= deadline || request.signal.aborted) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - now())));
  }
  if (!last.ok) throw last.cause;
  return await portPreviewFailure(
    "service_timeout",
    request,
    port,
    service.name,
  );
}

function tryOnce(attempt: () => Promise<Response>) {
  return attempt().then(
    (response) => ({ ok: true as const, response }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );
}
