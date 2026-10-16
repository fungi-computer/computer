import * as z from "zod";

/**
 * A Computer is its SQLite Workspace. Execution backends are optional and
 * plural: this module owns their vocabulary, their stable Workspace backend
 * ids, and the one routing decision that picks a backend for a command.
 *
 * Every shape here is secret-free. A hosted backing names a registered host
 * id at most; a local backend carries its device's public key and two display
 * labels, never a path on the member's machine.
 */
const hostIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const labelSchema = z.string().trim().min(1).max(256);

/** A backend the platform runs: a Cloudflare container or an on-box VM. */
export const hostedBackingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("platform-container") }),
  z.strictObject({ kind: z.literal("on-box-vm"), hostId: hostIdSchema }),
]);
export type HostedBacking = z.infer<typeof hostedBackingSchema>;

/** A member's machine, attached with a device key that never leaves it. */
export const localBackendSchema = z.strictObject({
  kind: z.literal("local"),
  deviceId: z.string().regex(/^[a-z2-7]{16}$/),
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: z.base64().length(44),
  hostLabel: labelSchema,
  folderLabel: labelSchema,
});
export type LocalBackend = z.infer<typeof localBackendSchema>;

export const attachedBackendSchema = z.discriminatedUnion("kind", [
  ...hostedBackingSchema.options,
  localBackendSchema,
]);
export type AttachedBackend = z.infer<typeof attachedBackendSchema>;

/** The stable Workspace backend id: its sync cursor is keyed by it. */
export function attachedBackendId(backend: AttachedBackend): string {
  switch (backend.kind) {
    case "platform-container":
      return "container";
    case "on-box-vm":
      return `vm-${backend.hostId}`;
    case "local":
      return `local-${backend.deviceId}`;
  }
}

/** One Computer's attached backends, in attach order; ids are unique. */
export const attachedBackendsSchema = z
  .array(attachedBackendSchema)
  .max(16)
  .refine(
    (backends) =>
      new Set(backends.map(attachedBackendId)).size === backends.length,
    "attached backend ids must be unique",
  );

export const attachedBackendIdSchema = z
  .string()
  .regex(/^(container|vm-[a-z0-9][a-z0-9-]{0,62}|local-[a-z2-7]{16})$/);

export type AttachedBackendStatus = "ready" | "online" | "offline";

/** What a Computer reports about one attached backend. */
export type AttachedBackendView = Readonly<{
  id: string;
  kind: AttachedBackend["kind"];
  status: AttachedBackendStatus;
  hostId?: string;
  hostLabel?: string;
  folderLabel?: string;
}>;

export function describeAttachedBackend(
  backend: AttachedBackend,
  online: boolean,
): AttachedBackendView {
  const id = attachedBackendId(backend);
  switch (backend.kind) {
    case "platform-container":
      return { id, kind: backend.kind, status: "ready" };
    case "on-box-vm":
      return {
        id,
        kind: backend.kind,
        status: "ready",
        hostId: backend.hostId,
      };
    case "local":
      return {
        id,
        kind: backend.kind,
        status: online ? "online" : "offline",
        hostLabel: backend.hostLabel,
        folderLabel: backend.folderLabel,
      };
  }
}

/** What a command needs from its backend. */
export type BackendNeed =
  /** A shell over the Computer's files: any attached backend. */
  | "exec"
  /** Terminal, processes or ports: a platform-run backend only. */
  | "hosted";

export type BackendRoute =
  | Readonly<{ kind: "routed"; id: string; backend: AttachedBackend }>
  /** The named backend is not attached, cannot serve the need, or is offline. */
  | Readonly<{ kind: "backend_unavailable"; id: string }>
  /** No attached backend can serve the command now. */
  | Readonly<{ kind: "no_backend" }>;

const defaultRank = {
  local: 0,
  "on-box-vm": 1,
  "platform-container": 2,
} as const satisfies Record<AttachedBackend["kind"], number>;

function serves(backend: AttachedBackend, need: BackendNeed): boolean {
  return need === "exec" || backend.kind !== "local";
}

/**
 * The single routing decision. An explicit id selects exactly that backend
 * and never falls back. Otherwise the default order is online local backends,
 * then on-box VMs, then the platform container, each kind in attach order.
 * Hosted backends start on demand, so only a local backend can be offline.
 */
export function routeComputerBackend(
  backends: readonly AttachedBackend[],
  online: (id: string) => boolean,
  request: Readonly<{ backend?: string | undefined; need: BackendNeed }>,
): BackendRoute {
  const available = (backend: AttachedBackend) =>
    serves(backend, request.need) &&
    (backend.kind !== "local" || online(attachedBackendId(backend)));
  if (request.backend !== undefined) {
    const backend = backends.find(
      (candidate) => attachedBackendId(candidate) === request.backend,
    );
    return backend !== undefined && available(backend)
      ? { kind: "routed", id: request.backend, backend }
      : { kind: "backend_unavailable", id: request.backend };
  }
  const chosen = backends
    .map((backend, index) => ({ backend, index }))
    .filter(({ backend }) => available(backend))
    .sort(
      (left, right) =>
        defaultRank[left.backend.kind] - defaultRank[right.backend.kind] ||
        left.index - right.index,
    )[0]?.backend;
  return chosen === undefined
    ? { kind: "no_backend" }
    : { kind: "routed", id: attachedBackendId(chosen), backend: chosen };
}

/** One container runtime a hosted backend started: the Computer-hours unit. */
export type ContainerRuntimeStart = Readonly<{
  runtimeId: string;
  backing: HostedBacking;
  startedAt: number;
}>;
