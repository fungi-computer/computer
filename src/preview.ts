import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { LONG, nanoid } from "@fungi.computer/cairn";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
const storedClaimsSchema = Schema.Struct({
  claims: Schema.String,
  expires_at: Schema.Number,
});
const lifetimeMs = 5 * 60_000;
const encoder = new TextEncoder();
const previewPath = /^\/__port_preview\/([a-z2-7]{20})(\/.*)?$/u;

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet.charAt((value << (5 - bits)) & 31);
  return result;
}

/**
 * Owns the persisted, bounded preview ticket and signed hostname. The caller
 * must still check live Computer exposure and admission before issue and after
 * consume; a ticket is not a grant.
 */
export type ComputerPreviewPolicy<Selector> = {
  selector: Schema.Codec<Selector, unknown>;
  previewUrl: (signature: string, domain: string) => string;
  accept: (selector: Selector) => void;
  listPorts: (accept: () => void) => Promise<{ ports: number[] }>;
  forward: (
    port: number,
    request: Request,
    accept: () => void,
  ) => Promise<Response>;
  portDenied: () => never;
  dispatchFailure: (error: Error) => Response;
  invalidClaims: () => void;
};

export class ComputerPortPreview<Selector> {
  constructor(
    private readonly storage: Pick<WatchdogSqliteOwner, "sql"> & {
      get(
        key: "computer_port_preview_signing_key",
      ): Promise<string | undefined>;
      put(
        key: "computer_port_preview_signing_key",
        value: string,
      ): Promise<void>;
    },
    private readonly policy: ComputerPreviewPolicy<Selector>,
  ) {}

  /** Match only the signed host route and forward a service-relative URL. */
  async route(
    request: Request,
    dispatch: (signature: string, request: Request) => Promise<Response>,
  ): Promise<Response | null> {
    const url = new URL(request.url);
    const preview = previewPath.exec(url.pathname);
    if (preview === null) return null;
    const service = new URL("http://localhost");
    service.pathname = preview[2] ?? "/";
    service.search = url.search;
    return await dispatch(preview[1] ?? "", new Request(service, request));
  }

  async issue(
    selector: Selector,
    port: number,
    previewOriginDomain: string,
  ): Promise<{ previewUrl: string; expiresAt: number }> {
    const expiresAt = Date.now() + lifetimeMs;
    const claims = JSON.stringify({ selector, port, expiresAt });
    const signature = await this.sign(claims);
    this.ensureTable();
    this.storage.sql.exec(
      "DELETE FROM computer_port_preview_tickets WHERE expires_at<=?",
      Date.now(),
    );
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO computer_port_preview_tickets(signature,claims,expires_at) VALUES(?,?,?)",
      signature,
      claims,
      expiresAt,
    );
    this.storage.sql.exec(
      "DELETE FROM computer_port_preview_tickets WHERE signature NOT IN (SELECT signature FROM computer_port_preview_tickets ORDER BY expires_at DESC LIMIT 256)",
    );
    return {
      previewUrl: this.policy.previewUrl(signature, previewOriginDomain),
      expiresAt,
    };
  }

  async resolve(
    signature: string,
  ): Promise<{ selector: Selector; port: number } | null> {
    this.ensureTable();
    const row = this.storage.sql
      .exec(
        "SELECT claims,expires_at FROM computer_port_preview_tickets WHERE signature=?",
        signature,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const stored = Schema.decodeUnknownSync(storedClaimsSchema)(row);
    if (stored.expires_at <= Date.now()) return null;
    if ((await this.sign(stored.claims)) !== signature) return null;
    const claimsSchema = Schema.Struct({
      selector: this.policy.selector,
      port: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      ),
      expiresAt: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isGreaterThan(0)),
      ),
    });
    const decoded = Schema.decodeUnknownOption(
      Schema.fromJsonString(claimsSchema),
    )(stored.claims);
    if (Option.isNone(decoded)) {
      this.policy.invalidClaims();
      return null;
    }
    const claims = decoded.value;
    return claims.expiresAt <= Date.now()
      ? null
      : { selector: claims.selector, port: claims.port };
  }

  /** A signed ticket is not authority: both issue and dispatch recheck live admission and exposure. */
  async issueAfterAcceptance(
    rawSelector: Selector,
    port: number,
    origin: string,
  ): Promise<{ previewUrl: string; expiresAt: number }> {
    const selector = Schema.decodeUnknownSync(this.policy.selector)(
      rawSelector,
    );
    const ports = await this.policy.listPorts(() => {
      this.policy.accept(selector);
    });
    if (!ports.ports.includes(port)) this.policy.portDenied();
    return await this.issue(selector, port, origin);
  }

  async dispatch(
    rawSelector: Selector,
    port: number,
    request: Request,
  ): Promise<Response> {
    const selector = Schema.decodeUnknownSync(this.policy.selector)(
      rawSelector,
    );
    try {
      return await this.policy.forward(port, request, () => {
        this.policy.accept(selector);
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return this.policy.dispatchFailure(error);
    }
  }

  async dispatchSigned(
    signature: string,
    request: Request,
    forward: (
      selector: Selector,
      port: number,
      request: Request,
    ) => Promise<Response>,
  ): Promise<Response> {
    const claims = await this.resolve(signature);
    if (claims === null) return new Response(null, { status: 403 });
    return await forward(claims.selector, claims.port, request);
  }

  private ensureTable(): void {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS computer_port_preview_tickets (signature TEXT PRIMARY KEY, claims TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT",
    );
  }

  private async sign(claims: string): Promise<string> {
    const storageKey = "computer_port_preview_signing_key";
    let secret = Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.String))(
      await this.storage.get(storageKey),
    );
    if (secret === undefined) {
      secret = nanoid(LONG) + nanoid(LONG);
      await this.storage.put(storageKey, secret);
    }
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(claims),
    );
    return base32(new Uint8Array(signature).slice(0, 12));
  }
}

/** Mount an isolated preview host with the owning host's target and forwarding policy. */
export async function computerPortPreviewRequest(
  request: Request,
  origin: string | null,
  host: {
    suffix: (domain: string) => string;
    target: (
      hostname: string,
      domain: string,
    ) => { computerId: string; signature: string } | null;
    forward: (computerId: string, request: Request) => Promise<Response>;
  },
): Promise<Response | null> {
  if (origin === null) return null;
  const incoming = new URL(request.url);
  if (
    incoming.protocol !== "https:" ||
    !incoming.hostname.endsWith(host.suffix(origin))
  )
    return null;
  const target = host.target(incoming.hostname, origin);
  if (target === null) return new Response(null, { status: 404 });
  const { computerId, signature } = target;
  const forwarded = new Request(request.url, request);
  try {
    const destination = new URL(forwarded.url);
    destination.pathname = `/__port_preview/${signature}${destination.pathname}`;
    return await host.forward(computerId, new Request(destination, forwarded));
  } catch {
    return new Response(null, { status: 503 });
  }
}
