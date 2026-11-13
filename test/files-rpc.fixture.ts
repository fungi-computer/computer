import { getWorkspace } from "@fungi.computer/cloudflare-computer";
import { z } from "zod";
import { createWorkspaceFilesPort } from "../src/files.js";
import { ComputerDO, type ComputerNamespace } from "../src/index.js";

/** Real SQLite Workspace and leased SDK stub; no execution backend is needed. */
export class FilesRpcProof extends ComputerDO {
  protected override attachedBackends() {
    return [];
  }
}

export default {
  async fetch(request: Request, env: { FILES: ComputerNamespace }) {
    const computer = env.FILES.getByName("files-rpc");
    using workspace = await getWorkspace(computer);
    await workspace.fs.writeFile("/visible.txt", "visible");
    const path = new URL(request.url).pathname;
    if (path === "/missing") {
      try {
        await workspace.fs.stat("/.gitignore");
        throw new Error("Missing stat unexpectedly succeeded");
      } catch (error) {
        return Response.json({
          remoteCode: z.object({ code: z.literal("ENOENT") }).safeParse(error)
            .success,
        });
      }
    }
    if (path === "/search") {
      const files = createWorkspaceFilesPort(workspace, computer);
      return Response.json(
        await files.glob({ path: "/", pattern: "*.txt", limit: 10 }),
      );
    }
    if (path === "/move") {
      const attempt = async (
        input: Parameters<
          ReturnType<ComputerNamespace["getByName"]>["call"]
        >[1],
      ) => {
        try {
          return { ok: await computer.call("move", input) };
        } catch (error) {
          return { refused: error instanceof Error ? error.message : "?" };
        }
      };
      const tree = async () =>
        (await workspace.fs.find("/lib", "**/*"))
          .map((entry) => entry.path)
          .sort();
      const out: Record<
        string,
        string | string[] | Awaited<ReturnType<typeof attempt>>
      > = {};
      await workspace.fs.mkdir("/lib/Characters/Mira", { recursive: true });
      await workspace.fs.writeFile("/lib/a.png", "a");
      await workspace.fs.writeFile("/lib/b.png", "b");
      await workspace.fs.writeFile("/lib/Characters/Mira/shot.png", "m");
      out.file = await attempt({
        from: "/lib/a.png",
        to: "/lib/Characters/a.png",
      });
      out.fileTree = await tree();
      out.fileBytes = await workspace.fs.readFile(
        "/lib/Characters/a.png",
        "utf8",
      );
      out.conflict = await attempt({
        from: "/lib/b.png",
        to: "/lib/Characters/a.png",
      });
      out.conflictSourceKept = await workspace.fs.readFile(
        "/lib/b.png",
        "utf8",
      );
      out.directory = await attempt({
        from: "/lib/Characters",
        to: "/lib/Cast",
      });
      out.directoryTree = await tree();
      out.intoSelf = await attempt({
        from: "/lib/Cast",
        to: "/lib/Cast/Mira/inner",
      });
      out.intoSelfRoot = await attempt({ from: "/lib/Cast", to: "/lib/Cast" });
      out.missingSource = await attempt({
        from: "/lib/none.png",
        to: "/lib/none2.png",
      });
      out.missingParent = await attempt({
        from: "/lib/b.png",
        to: "/lib/Places/b.png",
      });
      out.noParentCreated = await tree();
      out.createParents = await attempt({
        from: "/lib/b.png",
        to: "/lib/Places/Forest/b.png",
        createParents: true,
      });
      out.afterCreate = await tree();
      out.createThenRefuse = await attempt({
        from: "/lib/Cast",
        to: "/lib/Cast/x/y",
        createParents: true,
      });
      out.afterRefuse = await tree();
      return Response.json(out);
    }
    return new Response(null, { status: 404 });
  },
};
