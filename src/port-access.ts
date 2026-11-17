import { LONG, nanoid } from "@fungi.computer/cairn";
import { computerPortSchema } from "@fungi.computer/computer-contract";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { z } from "zod";

const visibilitySchema = z.enum(["private", "unlisted", "public"]);
/** Admission is checked by the host before it issues a port credential. */
export type PortAccessPrincipal =
  Readonly<{ userId: string; teamId: string }> | Readonly<{ ownerId: string }>;
const principalSchema = z.union([
  z.strictObject({ userId: z.string().min(1), teamId: z.string().min(1) }),
  z.strictObject({ ownerId: z.string().min(1) }),
]);
/** Visibility belongs to an existing exposed port, never a second catalog. */
export type PortVisibility = "private" | "unlisted" | "public";
const credentialSchema = z
  .string()
  .length(LONG)
  .regex(/^[a-z0-9]+$/);
const tokenLifetimeMs = 300_000;
const sessionLifetimeMs = 3_600_000;
const maximumPendingTokens = 64;

/** Refusal at the host's issuance or configuration boundary. */
export class PortAccessError extends Error {
  constructor(
    readonly reason:
      "unexposed" | "public_disabled" | "not_unlisted" | "capacity",
  ) {
    super(`Port access: ${reason}`);
  }
}

/** Additive migration: existing Oyster exposure rows remain private. */
export function initializePortAccess(storage: WatchdogSqliteOwner): void {
  storage.transactionSync(() => {
    const columns = storage.sql
      .exec("PRAGMA table_info(computer_exposed_ports)")
      .toArray();
    if (!columns.some((column) => column.name === "visibility"))
      storage.sql.exec(
        "ALTER TABLE computer_exposed_ports ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public'))",
      );
    if (!columns.some((column) => column.name === "share_token_hash"))
      storage.sql.exec(
        "ALTER TABLE computer_exposed_ports ADD COLUMN share_token_hash TEXT",
      );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS computer_port_connect (token_hash TEXT PRIMARY KEY, port INTEGER NOT NULL, principal_json TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS computer_port_session (session_hash TEXT PRIMARY KEY, port INTEGER NOT NULL, principal_json TEXT, kind TEXT NOT NULL CHECK (kind IN ('member','share')), expires_at INTEGER NOT NULL) STRICT",
    );
    // Every removal path (unexpose, process exit, idle sleep) revokes in the
    // same SQLite transaction, including a remove followed by re-exposure.
    storage.sql.exec(
      "CREATE TRIGGER IF NOT EXISTS computer_port_access_deleted AFTER DELETE ON computer_exposed_ports BEGIN DELETE FROM computer_port_connect WHERE port = OLD.port; DELETE FROM computer_port_session WHERE port = OLD.port; END",
    );
    storage.sql.exec(
      "CREATE TRIGGER IF NOT EXISTS computer_port_access_changed AFTER UPDATE OF visibility, share_token_hash ON computer_exposed_ports WHEN OLD.visibility IS NOT NEW.visibility OR OLD.share_token_hash IS NOT NEW.share_token_hash BEGIN DELETE FROM computer_port_connect WHERE port = OLD.port; DELETE FROM computer_port_session WHERE port = OLD.port; END",
    );
  });
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** One Computer's port credentials; the host owns membership and routing. */
export class ComputerPortAccess {
  constructor(
    private readonly storage: WatchdogSqliteOwner,
    private readonly options: Readonly<{
      publicAccess?: "on";
      now?: () => number;
    }> = {},
  ) {
    initializePortAccess(storage);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private visibility(port: number): PortVisibility | undefined {
    const row = this.storage.sql
      .exec(
        "SELECT visibility FROM computer_exposed_ports WHERE port = ?",
        port,
      )
      .toArray()[0];
    return row === undefined
      ? undefined
      : visibilitySchema.parse(row.visibility);
  }

  /** Returns a new share secret only when entering unlisted visibility. */
  async setVisibility(
    portInput: number,
    input: PortVisibility,
  ): Promise<string | null> {
    const port = computerPortSchema.parse(portInput);
    const visibility = visibilitySchema.parse(input);
    if (visibility === "public" && this.options.publicAccess !== "on")
      throw new PortAccessError("public_disabled");
    const share = visibility === "unlisted" ? nanoid(LONG) : null;
    const shareHash = share === null ? null : await hash(share);
    return this.storage.transactionSync(() => {
      const previous = this.visibility(port);
      if (previous === undefined) throw new PortAccessError("unexposed");
      if (previous === visibility) return null;
      this.storage.sql.exec(
        "UPDATE computer_exposed_ports SET visibility = ?, share_token_hash = ? WHERE port = ?",
        visibility,
        shareHash,
        port,
      );
      return share;
    });
  }

  /** Rotation revokes outstanding tokens and sessions in the same transaction. */
  async resetShare(portInput: number): Promise<string> {
    const port = computerPortSchema.parse(portInput);
    const secret = nanoid(LONG);
    const secretHash = await hash(secret);
    return this.storage.transactionSync(() => {
      if (this.visibility(port) !== "unlisted")
        throw new PortAccessError("not_unlisted");
      this.storage.sql.exec(
        "UPDATE computer_exposed_ports SET share_token_hash = ? WHERE port = ?",
        secretHash,
        port,
      );
      return secret;
    });
  }

  /** The host rechecks admission inside issuance, after asynchronous hashing. */
  async issue(
    portInput: number,
    input: PortAccessPrincipal,
    accept: () => void,
  ): Promise<string> {
    const port = computerPortSchema.parse(portInput);
    const principal = principalSchema.parse(input);
    const token = nanoid(LONG);
    const tokenHash = await hash(token);
    return this.storage.transactionSync(() => {
      accept();
      if (this.visibility(port) === undefined)
        throw new PortAccessError("unexposed");
      const now = this.now();
      this.storage.sql.exec(
        "DELETE FROM computer_port_connect WHERE expires_at <= ?",
        now,
      );
      const count = z
        .number()
        .int()
        .nonnegative()
        .parse(
          this.storage.sql
            .exec("SELECT COUNT(*) AS count FROM computer_port_connect")
            .toArray()[0]?.count,
        );
      if (count >= maximumPendingTokens) throw new PortAccessError("capacity");
      this.storage.sql.exec(
        "INSERT INTO computer_port_connect VALUES (?, ?, ?, ?)",
        tokenHash,
        port,
        JSON.stringify(principal),
        now + tokenLifetimeMs,
      );
      return token;
    });
  }

  private async exchange(
    port: number,
    secret: string,
    kind: "member" | "share",
  ): Promise<string | null> {
    if (!credentialSchema.safeParse(secret).success) return null;
    const secretHash = await hash(secret);
    const session = nanoid(LONG);
    const sessionHash = await hash(session);
    return this.storage.transactionSync(() => {
      const visibility = this.visibility(port);
      if (
        visibility === undefined ||
        (visibility === "public" && this.options.publicAccess !== "on")
      )
        return null;
      const now = this.now();
      let principal: string | null = null;
      if (kind === "member") {
        const row = this.storage.sql
          .exec(
            "DELETE FROM computer_port_connect WHERE token_hash = ? AND port = ? AND expires_at > ? RETURNING principal_json",
            secretHash,
            port,
            now,
          )
          .toArray()[0];
        if (row === undefined) return null;
        principal = JSON.stringify(
          principalSchema.parse(
            JSON.parse(z.string().parse(row.principal_json)),
          ),
        );
      } else {
        if (visibility !== "unlisted") return null;
        const row = this.storage.sql
          .exec(
            "SELECT port FROM computer_exposed_ports WHERE port = ? AND share_token_hash = ?",
            port,
            secretHash,
          )
          .toArray()[0];
        if (row === undefined) return null;
      }
      this.storage.sql.exec(
        "DELETE FROM computer_port_session WHERE expires_at <= ?",
        now,
      );
      this.storage.sql.exec(
        "INSERT INTO computer_port_session VALUES (?, ?, ?, ?, ?)",
        sessionHash,
        port,
        principal,
        kind,
        now + sessionLifetimeMs,
      );
      return session;
    });
  }

  private async admits(
    port: number,
    secret: string | undefined,
  ): Promise<boolean> {
    if (secret === undefined || !credentialSchema.safeParse(secret).success)
      return false;
    const sessionHash = await hash(secret);
    return (
      this.storage.sql
        .exec(
          "SELECT s.port FROM computer_port_session s JOIN computer_exposed_ports p ON p.port = s.port WHERE s.session_hash = ? AND s.port = ? AND s.expires_at > ? AND (p.visibility = 'unlisted' OR (p.visibility = 'private' AND s.kind = 'member'))",
          sessionHash,
          port,
          this.now(),
        )
        .toArray().length === 1
    );
  }

  /** Mount on one target host. Forwarding remains responsible for live exposure. */
  gate(
    portInput: number,
    entryUrl: string,
    forward: (request: Request) => Response | Promise<Response>,
  ): Hono {
    const port = computerPortSchema.parse(portInput);
    const app = new Hono();
    app.all("*", async (c) => {
      c.header("Cache-Control", "no-store");
      const denied = () =>
        c.req.header("sec-fetch-dest") === "document"
          ? c.html(
              html`<!doctype html><title>Open this from Fungi</title>
                <main>
                  <h1>Open this from Fungi</h1>
                  <a href="${entryUrl}">Open in Fungi</a>
                </main>`,
              401,
            )
          : c.body(null, 401);
      // Sibling preview hosts are same-site but must never use each other's
      // cookies. WebSockets bypass CORS, so require their exact origin too.
      const upgrade = c.req.raw.headers.has("upgrade");
      if (
        c.req.header("sec-fetch-site") === "same-site" ||
        (upgrade && c.req.header("origin") !== new URL(c.req.url).origin)
      )
        return denied();
      const visibility = this.visibility(port);
      if (
        visibility === undefined ||
        (visibility === "public" && this.options.publicAccess !== "on")
      )
        return denied();
      if (visibility !== "public") {
        const token = c.req.query("token");
        const share = c.req.query("t");
        const parameter =
          token !== undefined
            ? "token"
            : share !== undefined && visibility === "unlisted"
              ? "t"
              : null;
        // Vite owns its WebSocket token query; upgrades use an existing session.
        if (parameter !== null && !upgrade) {
          const session = await this.exchange(
            port,
            (parameter === "token" ? token : share) ?? "",
            parameter === "token" ? "member" : "share",
          );
          if (session === null) return denied();
          setCookie(c, "fungi-port", session, {
            prefix: "host",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
            path: "/",
            maxAge: 3600,
          });
          const target = new URL(c.req.url);
          target.searchParams.delete(parameter);
          c.header("Referrer-Policy", "no-referrer");
          return c.redirect(target.toString(), 302);
        }
        if (!(await this.admits(port, getCookie(c, "fungi-port", "host"))))
          return denied();
      }
      const headers = new Headers(c.req.raw.headers);
      for (const name of [
        "authorization",
        "cookie",
        "proxy-authorization",
        "cf-access-jwt-assertion",
        "cf-access-client-id",
        "cf-access-client-secret",
        "cf-access-authenticated-user-email",
        "x-authenticated-user",
        "x-authenticated-email",
        "x-auth-request-user",
        "x-auth-request-email",
        "x-user-id",
        "x-user-email",
        "x-forwarded-user",
        "x-forwarded-email",
      ])
        headers.delete(name);
      const response = await forward(new Request(c.req.raw, { headers }));
      const safe = new Response(response.body, response);
      safe.headers.delete("set-cookie");
      safe.headers.set("Cache-Control", "no-store");
      return safe;
    });
    return app;
  }
}
