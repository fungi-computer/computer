/**
 * The one host policy for a Computer's network egress: which origin, method
 * and route each outbound request names. Every host's egress gateway decides
 * here and refuses with the same response; a host serves only the lanes it
 * offers (Hub: team, public and its own App Git; standalone Oyster: its own
 * origin's Git) and refuses every other decision.
 */
import { z } from "zod";

export type PublicGitRoute = Readonly<{
  readonly host: "github.com" | "gitlab.com" | "codeberg.org";
  readonly repository: string;
  /** `push` is GitHub receive-pack only, and never tried anonymously. */
  readonly access: "read" | "push";
}>;

export type ComputerEgressDecision =
  | Readonly<{ kind: "team-git"; route: PublicGitRoute }>
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "internal-git" }>
  | Readonly<{ kind: "origin-git" }>
  | Readonly<{ kind: "denied"; reason: "origin" | "method" | "path" }>;

const publicGitHosts = new Set(["github.com", "gitlab.com", "codeberg.org"]);
const packageHosts = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "deb.debian.org",
  "archive.ubuntu.com",
]);
const releaseHosts = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const anonymousRequestHeaders = [
  "accept",
  "accept-encoding",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "range",
  "user-agent",
  "git-protocol",
] as const;
const publicResponseHeaders = [
  "accept-ranges",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "location",
] as const;

/** An HTTPS URL with the default port and no userinfo or fragment. */
export function egressHttpsUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === ""
  );
}

function publicGitRoute(url: URL, method: string): PublicGitRoute | null {
  if (!publicGitHosts.has(url.hostname)) return null;
  const match =
    /^\/([A-Za-z0-9_.-]{1,128})\/([A-Za-z0-9_.-]{1,128})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      url.pathname,
    );
  const owner = match?.[1];
  const repository = match?.[2];
  const endpoint = match?.[3];
  if (owner === undefined || repository === undefined || endpoint === undefined)
    return null;
  const exchange = (service: "git-upload-pack" | "git-receive-pack") =>
    (method === "GET" &&
      endpoint === "info/refs" &&
      url.search === `?service=${service}`) ||
    (method === "POST" && endpoint === service && url.search === "");
  const host = url.hostname;
  if (host !== "github.com" && host !== "gitlab.com" && host !== "codeberg.org")
    return null;
  const access = exchange("git-upload-pack")
    ? ("read" as const)
    : // Only a Team's GitHub connection can push; other hosts stay read-only.
      host === "github.com" && exchange("git-receive-pack")
      ? ("push" as const)
      : null;
  if (access === null) return null;
  return { host, repository: `${owner}/${repository}`, access };
}

function isGetOrHead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** Whether `url` is plain HTTPS on the host's configured root origin. An
 * absent origin admits nothing; a malformed one is a configuration error. */
export function sameOriginHttps(url: URL, origin: string | undefined): boolean {
  if (origin === undefined || !egressHttpsUrl(url)) return false;
  const configured = new URL(z.url().parse(origin));
  return (
    configured.pathname === "/" &&
    configured.search === "" &&
    configured.hash === "" &&
    configured.username === "" &&
    configured.password === "" &&
    url.origin === configured.origin
  );
}

/**
 * The host's own Git, as one more host entry: its configured origin and the
 * smart-HTTP grammar its Git door serves. Classification grants no transport
 * authority; the host's door still authenticates every exchange.
 */
export type OriginGitHost = Readonly<{
  origin: string | undefined;
  route(request: Pick<Request, "method">, url: URL): object | null;
}>;

/** One owner for origin, method and route decisions at Computer egress. */
export function decideComputerEgress(
  request: Pick<Request, "method">,
  url: URL,
  host?: OriginGitHost,
): ComputerEgressDecision {
  if (!egressHttpsUrl(url)) return { kind: "denied", reason: "origin" };

  if (
    url.hostname === "git.team.internal" ||
    url.hostname === "build.team.internal"
  )
    return { kind: "internal-git" };

  if (
    host !== undefined &&
    sameOriginHttps(url, host.origin) &&
    host.route(request, url) !== null
  )
    return { kind: "origin-git" };

  const gitRoute = publicGitRoute(url, request.method);
  if (gitRoute !== null) return { kind: "team-git", route: gitRoute };

  if (!isGetOrHead(request.method)) return { kind: "denied", reason: "method" };

  if (packageHosts.has(url.hostname) || releaseHosts.has(url.hostname))
    return { kind: "public" };

  if (
    url.hostname === "github.com" &&
    /^\/[A-Za-z0-9_.-]{1,128}\/[A-Za-z0-9_.-]{1,128}\/releases\/download\/[^/]+\/[^/]+(?:\/.*)?$/.test(
      url.pathname,
    )
  )
    return { kind: "public" };

  if (
    url.hostname === "codeload.github.com" &&
    /^\/[A-Za-z0-9_.-]{1,128}\/[A-Za-z0-9_.-]{1,128}\/(?:legacy\.(?:zip|tar\.gz)|archive)\//.test(
      url.pathname,
    )
  )
    return { kind: "public" };

  return { kind: "denied", reason: "origin" };
}

/** Remove all caller credentials and forward only transport headers needed by
 * anonymous registries and Git smart HTTP. `body: "move"` hands the caller's
 * stream over once (a push, which never has an anonymous attempt). */
export function anonymousRequest(
  request: Request,
  url: URL,
  options: Readonly<{ body: "clone" | "move" }> = { body: "clone" },
): Request {
  const headers = new Headers();
  for (const name of anonymousRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    // A GitHub public read can return 401/404 before Team custody is tried;
    // retain a second stream for that existing authorized fallback.
    const body = options.body === "move" ? request.body : request.clone().body;
    Object.assign(init, { body, duplex: "half" });
  }
  return new Request(url, init);
}

export function anonymousResponse(response: Response): Response {
  const headers = new Headers();
  for (const name of publicResponseHeaders) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function disabledTeamIds(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((teamId) => teamId.trim())
      .filter((teamId) => teamId.length > 0),
  );
}

export class ComputerEgressConfigError extends Error {
  override readonly name = "ComputerEgressConfigError";
  constructor(readonly issues: readonly string[]) {
    super(`Invalid Computer egress configuration: ${issues.join("; ")}`);
  }
}

const publicEgressSwitchSchema = z.enum(["enabled", "disabled"]).optional();

/** Public egress is on by default; only the explicit global kill switch
 * (`COMPUTER_PUBLIC_EGRESS=disabled`) turns it off. Any other configured
 * value fails closed with a typed config error rather than silently denying
 * or enabling egress. */
export function publicEgressEnabled(raw: string | undefined): boolean {
  const parsed = publicEgressSwitchSchema.safeParse(raw);
  if (!parsed.success)
    throw new ComputerEgressConfigError(
      parsed.error.issues.map(({ message }) => message),
    );
  return parsed.data !== "disabled";
}

export type PublicLaneDecision =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{
      kind: "denied";
      reason: "globally-disabled" | "team-disabled" | "computer-disabled";
    }>;

/** The public lane's one on/off decision, in the order its switches are
 * owned: the global kill switch, then the per-Team off list, then this
 * Computer's own switch. Either of the first two overrides this Computer's
 * own "on". */
export function decidePublicLane(
  input: Readonly<{
    publicEgressEnabled: boolean;
    teamDisabled: boolean;
    computerInternetAccessEnabled: boolean;
  }>,
): PublicLaneDecision {
  if (!input.publicEgressEnabled)
    return { kind: "denied", reason: "globally-disabled" };
  if (input.teamDisabled) return { kind: "denied", reason: "team-disabled" };
  if (!input.computerInternetAccessEnabled)
    return { kind: "denied", reason: "computer-disabled" };
  return { kind: "allowed" };
}

/** One structured line per egress decision, whichever host serves it. */
export type ComputerEgressEvent = Readonly<{
  event: "computer.egress";
  computerId: string;
  teamId: string | null;
  lane: "team-git" | "public" | "internal-git" | "origin-git" | "denied";
  host: string;
  method: string;
  status: number;
  decision: string;
  contentLength: string | null;
}>;

export function recordComputerEgress(event: ComputerEgressEvent): void {
  console.info(JSON.stringify(event));
}

/** The policy refusal every host returns; the reason stays in the log. */
export function computerEgressDenied(
  input: Omit<ComputerEgressEvent, "event" | "lane" | "contentLength">,
): Response {
  recordComputerEgress({
    event: "computer.egress",
    ...input,
    lane: "denied",
    contentLength: null,
  });
  return new Response("Computer egress denied by policy", {
    status: input.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Smart-HTTP transport headers plus the guest's own credential. */
const originGitRequestHeaders = [
  ...anonymousRequestHeaders,
  "authorization",
  "content-encoding",
] as const;

/**
 * An admitted origin-git exchange as a fresh request to the host's own Git
 * door. Only the guest's own credential (an owner key or workflow Git pass
 * Shed sets as `http.<remote>.extraHeader`) travels; the gateway adds none.
 */
export function originGitRequest(request: Request, url: URL): Request {
  const headers = new Headers();
  for (const name of originGitRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD")
    Object.assign(init, { body: request.body, duplex: "half" });
  return new Request(url, init);
}
