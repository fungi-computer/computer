import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { ComputerPortAccess, PortAccessError } from "../src/port-access.js";
import { ComputerProcessInventory } from "../src/process-inventory.js";

/** Each test gets an independent Computer database, seeded before migration. */
export class PortAccessProof extends DurableObject {
  private time = 1_000_000;
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (url.pathname === "/seed") {
      sql.exec(
        "CREATE TABLE computer_schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT",
      );
      sql.exec("INSERT INTO computer_schema_meta VALUES (0, 5)");
      sql.exec(
        "CREATE TABLE computer_exposed_ports (port INTEGER PRIMARY KEY CHECK (port BETWEEN 1 AND 65535), process_id TEXT) STRICT",
      );
      sql.exec(
        "INSERT INTO computer_exposed_ports VALUES (5173, 'retained-process'), (5174, NULL)",
      );
      new ComputerProcessInventory(this.ctx.storage, () => this.time);
      return Response.json(
        sql
          .exec("SELECT * FROM computer_exposed_ports ORDER BY port")
          .toArray(),
      );
    }
    let options: ConstructorParameters<typeof ComputerPortAccess>[1] = {
      now: () => this.time,
    };
    if (url.searchParams.get("public") === "on")
      options = { ...options, publicAccess: "on" };
    const access = new ComputerPortAccess(this.ctx.storage, options);
    // The fixture's site is its last two labels; Oyster supplies the public
    // suffix list.
    const policy = {
      entryUrl: "https://fungi.test/open",
      site: (target: URL) => target.hostname.split(".").slice(-2).join("."),
    };
    const port = z.coerce
      .number()
      .parse(url.searchParams.get("port") ?? "5173");
    if (url.pathname === "/issue") {
      try {
        const token = await access.issue(port, { ownerId: "owner" }, () => {
          if (url.searchParams.has("deny"))
            throw new PortAccessError("unexposed");
        });
        return Response.json({ token });
      } catch (error) {
        if (error instanceof PortAccessError)
          return new Response(null, { status: 409 });
        throw error;
      }
    }
    if (url.pathname === "/visibility") {
      const visibility = z
        .enum(["private", "unlisted", "public"])
        .parse(url.searchParams.get("value"));
      try {
        return Response.json({
          share: await access.setVisibility(port, visibility),
        });
      } catch (error) {
        if (error instanceof PortAccessError)
          return new Response(null, { status: 409 });
        throw error;
      }
    }
    if (url.pathname === "/reset")
      return Response.json({ share: await access.resetShare(port) });
    if (url.pathname === "/remove") {
      sql.exec("DELETE FROM computer_exposed_ports WHERE port = ?", port);
      return new Response(null);
    }
    if (url.pathname === "/reexpose") {
      sql.exec("INSERT INTO computer_exposed_ports(port) VALUES (?)", port);
      return new Response(null);
    }
    if (url.pathname === "/advance") {
      this.time += z.coerce.number().parse(url.searchParams.get("ms"));
      return new Response(null);
    }
    if (url.pathname === "/state")
      return Response.json({
        tokens: sql.exec("SELECT * FROM computer_port_connect").toArray(),
        sessions: sql.exec("SELECT * FROM computer_port_session").toArray(),
      });
    if (url.pathname === "/websocket-proof") {
      const gate = access.gate(port, policy, (forwarded) => {
        if (forwarded.headers.has("cookie"))
          throw new Error("credential leaked");
        if (forwarded.headers.get("upgrade") !== "websocket")
          throw new Error("upgrade lost");
        if (new URL(forwarded.url).search !== url.search)
          throw new Error("service query changed");
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(1000);
        return new Response(null, {
          status: 101,
          webSocket: pair[0],
          headers: { "set-cookie": "service=fixture" },
        });
      });
      const headers = new Headers(request.headers);
      headers.set("upgrade", "websocket");
      const result = await gate.fetch(
        new Request(`https://preview.test/socket${url.search}`, { headers }),
      );
      const socket = result.webSocket;
      socket?.accept();
      socket?.close(1000);
      return Response.json({
        status: result.status,
        socket: socket !== null,
        cookie: result.headers.has("set-cookie"),
      });
    }
    const gate = access.gate(port, policy, (forwarded) =>
      Response.json(
        {
          headers: Object.fromEntries(forwarded.headers),
          path: new URL(forwarded.url).pathname,
        },
        {
          headers: {
            "set-cookie": "session=service; Domain=test",
            "x-service": "kept",
          },
        },
      ),
    );
    return await gate.fetch(
      new Request(
        new URL(url.pathname + url.search, "https://preview.test"),
        request,
      ),
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: { HOST: DurableObjectNamespace<PortAccessProof> },
  ): Promise<Response> {
    const name = request.headers.get("x-test-computer") ?? "default";
    return await env.HOST.get(env.HOST.idFromName(name)).fetch(request);
  },
};
