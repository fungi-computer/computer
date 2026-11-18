import { getWorkspace } from "@fungi.computer/cloudflare-computer";
import { ComputerDO, type ComputerNamespace } from "../src/index.js";

export { WorkspaceProxy, WorkspaceServiceProxy } from "../src/index.js";

/** Real Worker Loader shell, minted through every module group the Computer loads. */
export class ShellGroupsProof extends ComputerDO {
  protected override attachedBackends() {
    return [];
  }
}

export default {
  async fetch(request: Request, env: { COMPUTER: ComputerNamespace }) {
    const url = new URL(request.url);
    const command = url.searchParams.get("command");
    if (url.pathname !== "/run" || command === null)
      return new Response("Not found", { status: 404 });
    try {
      using workspace = await getWorkspace(
        env.COMPUTER.getByName("shell-groups"),
      );
      await workspace.fs.mkdir("/data", { recursive: true });
      await workspace.fs.writeFile(
        "/data/sample.csv",
        "name,n\nfern,1\nmoss,2\n",
      );
      await workspace.fs.writeFile("/data/sample.yaml", "a:\n  b: 7\n");
      using run = await workspace.runtime.exec(command, {
        encoding: "utf8",
        timeoutMs: 60_000,
        cwd: "/data",
      });
      const result = await run.result();
      return Response.json({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        },
        { status: 500 },
      );
    }
  },
};
