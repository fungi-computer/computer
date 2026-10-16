import type {
  IWorkspaceContainerAPI,
  WorkspaceRef,
} from "@fungi.computer/cloudflare-computer/backends/container";
import type {
  ContainerRuntimeStart,
  HostedBacking,
} from "./computer-backends.js";

/**
 * A container host that reports each runtime it starts. Every other call
 * passes through unchanged, so the container backend cannot tell it apart
 * from the host it wraps.
 */
export class MeteredContainerHost implements IWorkspaceContainerAPI {
  readonly #host: IWorkspaceContainerAPI;
  readonly #backing: HostedBacking;
  readonly #started: (start: ContainerRuntimeStart) => void;

  constructor(
    host: IWorkspaceContainerAPI,
    backing: HostedBacking,
    started: (start: ContainerRuntimeStart) => void,
  ) {
    this.#host = host;
    this.#backing = backing;
    this.#started = started;
  }

  async #report(boot: Promise<{ runtimeId: string }>) {
    const runtime = await boot;
    this.#started({
      runtimeId: runtime.runtimeId,
      backing: this.#backing,
      startedAt: Date.now(),
    });
    return runtime;
  }

  start(env: Record<string, string>, enableInternet: boolean) {
    return this.#report(this.#host.start(env, enableInternet));
  }

  restart(env: Record<string, string>, enableInternet: boolean) {
    return this.#report(this.#host.restart(env, enableInternet));
  }

  status(): ReturnType<IWorkspaceContainerAPI["status"]> {
    return this.#host.status();
  }

  exitInfo(): ReturnType<IWorkspaceContainerAPI["exitInfo"]> {
    return this.#host.exitInfo();
  }

  interceptOutboundHttp(host: string, workspace: WorkspaceRef) {
    return this.#host.interceptOutboundHttp(host, workspace);
  }

  interceptAllOutboundHttp(workspace: WorkspaceRef, token: string) {
    return this.#host.interceptAllOutboundHttp(workspace, token);
  }

  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit) {
    return this.#host.fetchPort(port, input, init);
  }

  port(port: number) {
    return this.#host.port(port);
  }
}
