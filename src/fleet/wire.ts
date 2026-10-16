import { z } from "zod";
import {
  computerOperationSchema,
  computerValueSchema,
  pathSchema,
} from "../operation-contract.js";
import {
  attachedBackendId,
  hostedBackingSchema,
  localBackendSchema,
  type AttachedBackend,
} from "../computer-backends.js";

/** Operations the host may admit on one Computer. */
export const computerActionSchema = z.enum([
  ...computerOperationSchema.options,
  "terminal",
  "start",
  "stop",
  "processStart",
  "processList",
  "processKill",
  "exposePort",
  "unexposePort",
  "listPorts",
  "backing",
  "delete",
]);
export type ComputerAction = z.output<typeof computerActionSchema>;

/** Opaque host identities; the fleet does not derive authority from their text. */
export const computerProvenanceSchema = z.strictObject({
  actor: z.string().min(1),
  via: z.string().min(1).optional(),
});
export type ComputerProvenance = z.output<typeof computerProvenanceSchema>;

/** Host-issued data, never a request body's claim to authority. Times are milliseconds. */
export const computerGrantSchema = z.strictObject({
  computerId: z.string().min(1).max(256),
  actions: z.set(computerActionSchema).readonly(),
  expiresAt: z.number().int().nonnegative(),
  /** Host-specific policy data travels downward without an upward policy callback. */
  egress: computerValueSchema.optional(),
  provenance: computerProvenanceSchema,
});
export type ComputerGrant = z.output<typeof computerGrantSchema>;

/** State visible without knowing which application hosts the Computer. */
export const computerStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.enum(["running", "sleeping", "starting"]) }),
  z.strictObject({
    state: z.literal("queued"),
    position: z.number().int().positive(),
  }),
]);
export type ComputerRuntimeState = z.output<typeof computerStateSchema>;

/** Hosted fallback order, with the same bound and identity law as the retained owner. */
export const hostedBackingsSchema = z
  .array(hostedBackingSchema)
  .max(4)
  .refine(
    (backings) =>
      new Set(backings.map(attachedBackendId)).size === backings.length,
    "hosted backings must be distinct",
  );

/** The host delivers this complete revision to its Computer runtime. */
export type ComputerBackendsProjection = Readonly<{
  computerId: string;
  revision: number;
  backends: readonly AttachedBackend[];
}>;

/** An explicit override, or the fleet default when no Computer is selected. */
export const computerBackingChangeSchema = z.strictObject({
  computerId: z.string().min(1).max(256).optional(),
  backings: hostedBackingsSchema.nullable(),
});
export type ComputerBackingChange = Readonly<{
  computerId?: string | undefined;
  backings: readonly z.output<typeof hostedBackingSchema>[] | null;
}>;

/** A backing operation was refused without changing the stored decision. */
export class ComputerBackingError extends Error {
  constructor(
    readonly code:
      | "unknown_computer"
      | "not_enabled"
      | "invalid"
      | "request_conflict"
      | "local_limit"
      | "not_owner",
  ) {
    super(`Computer backing refused: ${code}`);
    this.name = "ComputerBackingError";
  }
}

/** Local device attachment uses an opaque actor supplied by the host. */
export const localBackendAttachSchema = z.strictObject({
  computerId: z.string().min(1).max(256),
  publicKey: localBackendSchema.shape.publicKey,
  hostLabel: localBackendSchema.shape.hostLabel,
  folderLabel: localBackendSchema.shape.folderLabel,
  requestId: z.string().min(1).max(256),
});
export type LocalBackendAttachInput = z.output<typeof localBackendAttachSchema>;
export const localBackendDetachSchema = z.strictObject({
  computerId: z.string().min(1).max(256),
  backendId: z.string().regex(/^local-[a-z2-7]{16}$/),
});
/** Recover a lost attach response without retaining the device key. */
export const localBackendDetachRequestSchema = z.strictObject({
  computerId: localBackendAttachSchema.shape.computerId,
  requestId: localBackendAttachSchema.shape.requestId,
});
export type LocalBackendDetachInput =
  | z.output<typeof localBackendDetachSchema>
  | z.output<typeof localBackendDetachRequestSchema>;

const factIdentity = {
  computerId: computerGrantSchema.shape.computerId,
  provenance: computerProvenanceSchema,
};
/** One runtime observation; the host owns delivery and settlement. */
export const computerUsageIntervalSchema = z.strictObject({
  runtimeId: z.string().min(1).max(128),
  backing: hostedBackingSchema,
  startedAt: z.number().int().nonnegative(),
  /** The last observed instant; final once `ended` is true. */
  observedAt: z.number().int().nonnegative(),
  ended: z.boolean(),
});
/** Spelled out: it types a Durable Object RPC parameter. */
export type ComputerUsageInterval = Readonly<{
  runtimeId: string;
  backing:
    | Readonly<{ kind: "platform-container" }>
    | Readonly<{ kind: "on-box-vm"; hostId: string }>;
  startedAt: number;
  observedAt: number;
  ended: boolean;
}>;

const timestamp = z.number().int().nonnegative();

/** Observations, not billing decisions. The host owns delivery and settlement. */
export const computerFactSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...factIdentity,
    kind: z.literal("process.exited"),
    requestId: z.string().min(1),
    exitCode: z.number().int().nullable(),
    /** Null means the backend did not measure CPU; it does not mean zero usage. */
    cpuTimeMs: z.number().nonnegative().nullable(),
    wallTimeMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ...factIdentity,
    kind: z.literal("files.written"),
    path: pathSchema,
    bytes: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...factIdentity,
    kind: z.literal("egress"),
    /** Only the destination host; URLs may carry credentials in paths or queries. */
    host: z.string().min(1),
    method: z.string().min(1),
    status: z.number().int().min(100).max(599),
  }),
  z.strictObject({
    ...factIdentity,
    kind: z.literal("lifecycle"),
    observedAt: timestamp,
    state: computerStateSchema,
  }),
  z.strictObject({
    ...factIdentity,
    kind: z.literal("interval"),
    ...computerUsageIntervalSchema.shape,
  }),
]);
export type ComputerFact = z.output<typeof computerFactSchema>;
