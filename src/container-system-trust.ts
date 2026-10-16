import type { BackendHandle } from "@fungi.computer/cloudflare-computer";
import {
  CloudflareContainerBackend,
  type CloudflareContainerBackendOptions,
} from "@fungi.computer/cloudflare-computer/backends/container";

/** Prepare intercepted HTTPS trust after the native backend installs its CA. */
export class SystemTrustContainerBackend extends CloudflareContainerBackend {
  readonly #intercepted: boolean;

  constructor(options: CloudflareContainerBackendOptions) {
    super(options);
    this.#intercepted = options.egress?.mode === "http-gateway";
  }

  override async connect(): Promise<BackendHandle> {
    const handle = await super.connect();
    if (!this.#intercepted) return handle;
    try {
      await installContainerSystemTrust(handle.rpc.shell);
      return handle;
    } catch (error) {
      await handle.close().catch((cause: unknown) => {
        console.error("Computer trust setup cleanup failed", cause);
        return undefined;
      });
      throw error;
    }
  }
}

async function installContainerSystemTrust(
  shell: BackendHandle["rpc"]["shell"],
): Promise<void> {
  // computerd runs without root, so create its OpenSSL bundle in /tmp. The
  // atomic rename lets simultaneous connections prepare the same CA safely.
  // Await it before Workspace can dispatch caller commands.
  const execution = await shell.exec({
    source:
      "set -eu; " +
      "test -r /etc/cloudflare/certs/cloudflare-containers-ca.crt || exit 78; " +
      "trust_tmp=$(mktemp /tmp/fungi-ca-XXXXXX); " +
      'cat /etc/ssl/certs/ca-certificates.crt /etc/cloudflare/certs/cloudflare-containers-ca.crt > "$trust_tmp"; ' +
      'chmod 0644 "$trust_tmp"; ' +
      'mv "$trust_tmp" /tmp/fungi-ca-bundle.crt',
    cwd: "/",
    timeoutMs: 10_000,
  });
  const reader = execution.events.getReader();
  try {
    let exitCode: number | undefined;
    for (;;) {
      const event = await reader.read();
      if (event.done) break;
      if (event.value.name === "exit") exitCode = event.value.code;
    }
    if (exitCode === 78)
      throw new Error(
        "Computer runtime interception CA is missing or unreadable",
      );
    if (exitCode !== 0)
      throw new Error(
        `Computer intercepted HTTPS trust setup failed (exit ${String(exitCode)})`,
      );
  } catch (error) {
    await shell.disposeExec({ id: execution.id }).catch((cause: unknown) => {
      console.error("Computer trust setup cleanup failed", cause);
      return undefined;
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
  await shell.disposeExec({ id: execution.id });
}
