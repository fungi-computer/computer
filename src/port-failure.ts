import { html, raw } from "hono/html";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Names the VM host's own refusal of a port request (vmd's `refusePort` in
 * tooling/celld-platform/computer-vm/vmd-proxy.mjs, which strips it from
 * guest replies), so a preview can tell it from the guest's answer.
 */
const portFailureHeader = "x-fungi-port-failure";

const hostRefusalSchema = Schema.Literals([
  "not_running",
  "not_listening",
  "unreachable",
]);

/**
 * Why a Computer port preview has nothing to show. `not_running`: the
 * Computer is asleep (a preview never wakes it). `not_listening`: nothing in
 * the Computer answers on that port. `unreachable`: Fungi could not reach the
 * Computer. `expired`: the preview link's five-minute ticket ran out.
 */
export type PortPreviewFailure =
  | Schema.Schema.Type<typeof hostRefusalSchema>
  | "unreachable"
  | "expired"
  | "service_timeout";

/**
 * The VM host's typed refusal, or null when the reply is the guest's own.
 * vmd pipes an upgrade's bytes raw, so on an upgrade request the header could
 * be the guest's and is never read.
 */
export function portPreviewRefusal(
  response: Response,
  request: Request,
): PortPreviewFailure | null {
  if (request.headers.has("upgrade")) return null;
  const named = Schema.decodeUnknownOption(hostRefusalSchema)(
    response.headers.get(portFailureHeader),
  );
  return Option.isSome(named) ? named.value : null;
}

/** How long a preview waits for a declared service to open its port. */
export const declaredPortWaitSeconds = 20;

const copy = {
  not_running: () => ({
    title: "This Computer is asleep",
    detail: "Start it from Fungi, then reload this page to see the preview.",
  }),
  not_listening: (port: number | undefined) => ({
    title:
      port === undefined
        ? "Nothing is answering on this port"
        : `Nothing is answering on port ${String(port)}`,
    detail:
      "Start the server on this Computer, or check its port, then reload this page.",
  }),
  unreachable: () => ({
    title: "Fungi couldn't reach this Computer",
    detail: "Reload in a moment. If it keeps happening, report it.",
  }),
  expired: () => ({
    title: "This preview link has expired",
    detail: "Open the preview again from Fungi to get a fresh link.",
  }),
  service_timeout: (port, service) => ({
    title:
      service === undefined || port === undefined
        ? "The service didn't open its port in time"
        : serviceTimeoutMessage(service, port),
    detail:
      "Check its output under Services on this Computer's card, then reload this page.",
  }),
} satisfies Record<
  PortPreviewFailure,
  (
    port: number | undefined,
    service: string | undefined,
  ) => Readonly<{ title: string; detail: string }>
>;

/** The one sentence for a declared service that never opened its port. */
function serviceTimeoutMessage(service: string, port: number): string {
  return `${service} didn't open port ${String(port)} within ${String(declaredPortWaitSeconds)} s`;
}

const statuses = {
  not_running: 503,
  not_listening: 502,
  unreachable: 502,
  expired: 403,
  service_timeout: 504,
} as const satisfies Record<PortPreviewFailure, number>;

// The preview origin is isolated and loads no Fungi asset, so the page's
// styling travels inline and follows the viewer's light or dark scheme.
const style = raw(`<style>
:root{color-scheme:light dark;--bg:#faf8f4;--card:#fff;--ink:#2a2622;--muted:#6f675e;--line:#e4ded4;--accent:#1f6f54;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#171512;--card:#211e1a;--ink:#f0ebe3;--muted:#a39a8e;--line:#3a352e;--accent:#58c29b;--accent-ink:#0f1a15}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:1rem}
main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.5rem}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 1rem;color:var(--muted)}
a{display:inline-block;font-weight:600;border-radius:8px;padding:.45rem 1rem;background:var(--accent);color:var(--accent-ink);text-decoration:none}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>`);

/**
 * The one answer a failed preview gives: a styled page in plain words for a
 * browser document, or `{ error: reason }` for a script's request. Raw
 * upstream text never reaches the viewer.
 */
export async function portPreviewFailure(
  reason: PortPreviewFailure,
  request: Request,
  port?: number,
  service?: string,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const status = statuses[reason];
  if (request.headers.get("sec-fetch-dest") !== "document")
    return Response.json(
      reason === "service_timeout"
        ? {
            error: reason,
            message:
              service === undefined || port === undefined
                ? "The service didn't open its port in time"
                : serviceTimeoutMessage(service, port),
          }
        : { error: reason },
      { status, headers },
    );
  const { title, detail } = copy[reason](port, service);
  const page = await html`<!doctype html>
    <html lang="en">
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      ${style}
      <main>
        <h1>${title}</h1>
        <p>${detail}</p>
        ${reason === "expired" ? "" : html`<a href="">Reload</a>`}
      </main>
    </html>`;
  return new Response(page, {
    status,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * What a preview answers for a forwarded port reply: the VM host's own
 * refusal in plain words, or the guest's reply as it is, minus cookies.
 */
export async function portPreviewReply(
  response: Response,
  request: Request,
  port: number,
): Promise<Response> {
  const refused = portPreviewRefusal(response, request);
  if (refused !== null) {
    await response.body?.cancel();
    return await portPreviewFailure(refused, request, port);
  }
  const safe = new Response(response.body, response);
  safe.headers.delete("set-cookie");
  return safe;
}
