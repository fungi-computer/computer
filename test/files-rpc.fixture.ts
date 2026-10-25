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
    return new Response(null, { status: 404 });
  },
};
