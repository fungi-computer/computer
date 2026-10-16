import { replayKey, defineIdFamily } from "@fungi.computer/cairn";
import * as z from "zod";
import { attachedBackendIdSchema } from "./computer-backends.js";

const utf8 = new TextEncoder();

export const maximumFileBytes = 128 * 1_024;
export const maximumListEntries = 256;
export const maximumPatternCharacters = 512;
export const maximumCommandCharacters = 16 * 1_024;
export const maximumStreamBytes = 64 * 1_024;
/** The bound for ordinary Computer commands; hosts own any admitted job budget. */
export const maximumExecutionTimeMs = 120_000;

/** Host-owned policy, never supplied in a Computer request body. */
export type ComputerExecutionBudget = Readonly<{ maximumTimeMs: number }>;
export const genericComputerExecutionBudget: ComputerExecutionBudget =
  Object.freeze({ maximumTimeMs: maximumExecutionTimeMs });

export const computerValueSchema = z.json();
export type ComputerValue = z.output<typeof computerValueSchema>;

export const capabilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);

/** One valid TCP port number, used only with this Computer's container. */
export const computerPortSchema = z.number().int().min(1).max(65_535);
export const maximumExposedPorts = 64;
/** computerd's Workspace RPC port, pinned by the Cloudflare container backend. */
export const computerDaemonPort = 8080;
/** The Computer-owned terminal server inside the container image. */
export const computerTerminalPort = 7681;
/**
 * Ports served by the Computer's own in-container daemons. An admitted
 * preview must never reach a control plane.
 */
export const computerReservedPorts: ReadonlySet<number> = new Set([
  computerDaemonPort,
  computerTerminalPort,
]);
export function isComputerReservedPort(port: number): boolean {
  return computerReservedPorts.has(port);
}
export const computerPortInputSchema = z.strictObject({
  port: computerPortSchema,
});
export const computerPortOutputSchema = z.strictObject({
  port: computerPortSchema,
  exposed: z.boolean(),
});
export const computerPortRemovalOutputSchema = z.strictObject({
  port: computerPortSchema,
  removed: z.boolean(),
});
export const computerPortsOutputSchema = z.strictObject({
  ports: z.array(computerPortSchema).max(maximumExposedPorts),
});

/** The port belongs to a Computer daemon and cannot be admitted for preview. */
export class ComputerPortReservedError extends Error {
  constructor(port: number) {
    super(`Computer port ${String(port)} is reserved`);
    this.name = "ComputerPortReservedError";
  }
}

/** A requested port cannot be reserved; no other process identity is disclosed. */
export class ComputerPortConflictError extends Error {
  constructor() {
    super("Computer port is unavailable");
    this.name = "ComputerPortConflictError";
  }
}

/** This Computer already admits the maximum number of preview ports. */
export class ComputerPortLimitError extends Error {
  constructor() {
    super(`Computer can expose at most ${String(maximumExposedPorts)} ports`);
    this.name = "ComputerPortLimitError";
  }
}

// Schema keywords are opaque transport data. Zod still validates every value
// as JSON before the description leaves or enters the Computer boundary.
const schemaDocument = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => computerValueSchema.safeParse(value).success,
    "Capability schema must contain JSON values",
  );

/** Native operation descriptions shared by discovery and its OpenAPI document. */
export const computerCapabilitiesSchema = z.array(
  z.strictObject({
    id: capabilityNameSchema,
    name: capabilityNameSchema,
    kind: z.string(),
    description: z.string(),
    parameters: schemaDocument,
    output: schemaDocument,
  }),
);

export const pathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .startsWith("/")
  .refine((path) => !path.includes("\0"), "Path cannot contain null bytes");

export const boundedTextSchema = (minimumLength = 0) =>
  z
    .string()
    .min(minimumLength)
    .refine(
      (content) => utf8.encode(content).byteLength <= maximumFileBytes,
      `Text exceeds the ${String(maximumFileBytes)}-byte Computer bound`,
    );

/** Complete bounded UTF-8 text reads. Binary reads use the same path input. */
export const readInputSchema = z.strictObject({ path: pathSchema });
export type ComputerFileReadInput = z.output<typeof readInputSchema>;
export const readOutputSchema = z.strictObject({
  path: pathSchema,
  content: boundedTextSchema(),
});
export type ComputerFileReadOutput = z.output<typeof readOutputSchema>;
/** Optional byte window; text reads remain complete and independently bounded. */
export const readBytesInputSchema = z.strictObject({
  path: pathSchema,
  byteOffset: z.number().int().nonnegative().optional(),
  byteLength: z.number().int().positive().max(maximumFileBytes).optional(),
});
export type ComputerFileByteReadInput = z.output<typeof readBytesInputSchema>;

/** Finite byte-read reply used by admitted App frame bindings. */
export const computerByteReadReplySchema = z.strictObject({
  path: readBytesInputSchema.shape.path,
  byteOffset: z.number().int().nonnegative(),
  content: z.string(),
  encoding: z.literal("base64"),
  truncated: z.boolean(),
});

/** Host-admitted App method preview; parsing does not grant port access. */
export const appMethodPreviewResultSchema = z.strictObject({
  previewUrl: z.url(),
  expiresAt: z.number().int().positive(),
});

export const listLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(maximumListEntries)
  .default(100);
export const listOffsetSchema = z.number().int().nonnegative().default(0);
export const listInputSchema = z.strictObject({
  path: pathSchema.default("/"),
  limit: listLimitSchema,
  offset: listOffsetSchema,
});
const listEntrySchema = z.strictObject({
  name: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number(),
  type: z.enum(["file", "directory", "symlink"]),
});
export const listOutputSchema = z.strictObject({
  path: pathSchema,
  entries: z.array(listEntrySchema).max(maximumListEntries),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type ComputerFileListInput = z.output<typeof listInputSchema>;
export type ComputerFileListOutput = z.output<typeof listOutputSchema>;

export const fileContentSchema = z
  .string()
  .refine(
    (content) => utf8.encode(content).byteLength <= maximumFileBytes,
    "File exceeds the Computer write bound",
  );
export const writeInputSchema = z.strictObject({
  path: pathSchema,
  content: fileContentSchema,
});
export const writeOutputSchema = z.strictObject({
  path: pathSchema,
  bytes: z.number().int().nonnegative(),
});
export type ComputerFileWriteInput = z.output<typeof writeInputSchema>;
export type ComputerFileWriteOutput = z.output<typeof writeOutputSchema>;
export const writeBytesInputSchema = readInputSchema;

export const replaceInputSchema = z.strictObject({
  path: pathSchema,
  expectedContent: fileContentSchema,
  content: fileContentSchema,
});
export const replaceOutputSchema = writeOutputSchema;

export const globInputSchema = z.strictObject({
  path: pathSchema,
  pattern: z.string().min(1).max(maximumPatternCharacters),
  limit: z
    .number()
    .int()
    .min(1)
    .max(maximumListEntries)
    .default(maximumListEntries),
});
export const globOutputSchema = z.strictObject({
  path: pathSchema,
  matches: z.array(pathSchema).max(maximumListEntries),
  truncated: z.boolean(),
});

export const grepInputSchema = z.strictObject({
  path: pathSchema,
  pattern: z.string().min(1).max(maximumPatternCharacters),
  regex: z.boolean().default(false),
  ignoreCase: z.boolean().default(false),
  limit: z
    .number()
    .int()
    .min(1)
    .max(maximumListEntries)
    .default(maximumListEntries),
});
export const grepOutputSchema = z.strictObject({
  path: pathSchema,
  matches: z
    .array(
      z.strictObject({
        path: pathSchema,
        line: z.number().int().positive(),
        text: z.string(),
      }),
    )
    .max(maximumListEntries),
  truncated: z.boolean(),
});

export const editInputSchema = z.strictObject({
  path: pathSchema,
  oldText: boundedTextSchema(1),
  newText: boundedTextSchema(),
});
export const editOutputSchema = z.strictObject({
  path: pathSchema,
  bytes: z.number().int().nonnegative(),
  diff: z.string(),
  firstChangedLine: z.number().int().positive().nullable(),
});

// Native Files tools and Computer HTTP decode the same patch contract.
export {
  patchInputSchema,
  patchOutputSchema,
} from "@fungi.computer/knapsack/files-patch";

export const mkdirInputSchema = z.strictObject({
  path: pathSchema,
  recursive: z.boolean().default(true),
});
export const mkdirOutputSchema = z.strictObject({ path: pathSchema });

/**
 * Host-owned idempotency key for one `exec` or `bash` tool invocation. The
 * host mints it once per invocation and keeps it across its own retries of that
 * invocation; the model never sees or supplies it.
 */
export const computerRequestIdSchema = z.uuid({ version: "v7" });
export type ComputerRequestId = z.output<typeof computerRequestIdSchema>;

/** Mint the request ID for one host tool invocation. */
export function mintComputerRequestId(): ComputerRequestId {
  return computerRequestIdSchema.parse(replayKey());
}

/** Model-facing command input. It carries no request identity. */
function executionInputSchema(budget: ComputerExecutionBudget) {
  return z.strictObject({
    command: z.string().min(1).max(maximumCommandCharacters),
    cwd: pathSchema.optional(),
    /** An attached backend id; omitted routes by the Computer's default order. */
    backend: attachedBackendIdSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(budget.maximumTimeMs)
      .default(10_000),
  });
}
export const execInputSchema = executionInputSchema(
  genericComputerExecutionBudget,
);

/** Resource hosts select a budget only after admitting their job principal. */
export function computerExecutionRequestSchema(
  budget: ComputerExecutionBudget,
) {
  return executionInputSchema(budget).extend({
    requestId: computerRequestIdSchema,
  });
}
/** Host-to-Computer command request: the model input plus the host's ID. */
export const execRequestSchema = execInputSchema.extend({
  requestId: computerRequestIdSchema,
});
export const execOutputSchema = z.strictObject({
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
/** One long-running container process owned by this Computer. */
const processIds = defineIdFamily({
  family: "computer-process",
  version: 1,
  kinds: { process: { prefix: "computer_process" } },
}).process;
export const computerProcessIdSchema = z
  .string()
  .refine((value) => processIds.is(value));
export type ComputerProcessId = z.output<typeof computerProcessIdSchema>;
/** At most this many processes may be running in one host scope at once. */
export const maximumRunningProcesses = 16;
/** At most this many process records, running or exited, are kept per host scope. */
export const maximumProcessRecords = 64;

/** Mint the durable identity of one started process. */
export function mintComputerProcessId(): ComputerProcessId {
  return processIds.generate();
}

export const processStartInputSchema = z.strictObject({
  requestId: z.string().min(1).max(256),
  requestScope: z.string().min(1).max(512),
  port: computerPortSchema.optional(),
  command: z.string().min(1).max(maximumCommandCharacters),
  cwd: pathSchema.optional(),
});
/** Model input excludes the host's replay identity and authority scope. */
export const processStartToolInputSchema = processStartInputSchema.omit({
  requestId: true,
  requestScope: true,
});

/** A trusted App host binds replay identity to its admitted installation and caller. */
export function installationProcessScope(
  installation: string,
  method: string,
  actor: Readonly<{ kind: "member" | "agent" | "team-key"; id: string }>,
): string {
  return processStartInputSchema.shape.requestScope.parse(
    `installation:${JSON.stringify([installation, method, `${actor.kind}:${actor.id}`])}`,
  );
}

export const processIdInputSchema = z.strictObject({
  id: computerProcessIdSchema,
});
/**
 * `running`: computerd still reports the execution live. `exited`: it ended;
 * `exitCode` is null when the runtime that ran it was replaced or its record
 * expired before the exit code was observed. `uncertain`: the Computer could
 * not reach its container to check, so neither is claimed.
 */
export const computerProcessStateSchema = z.enum([
  "running",
  "exited",
  "uncertain",
]);
/**
 * `synced`: the drain that recorded this exit read all the way to EOF,
 * which is also the read that runs computerd's post-command pull.
 * `pending`: that drain gave up waiting at its own deadline (a
 * backgrounded child, for example `node server.js &`, can hold the
 * transport open long after its parent exits) -- a background
 * continuation keeps watching and upgrades this row to `synced` once it
 * reaches that real EOF, so `pending` rows stay updatable. `unknown`:
 * this exit was recorded with no pull evidence at all (a replaced
 * runtime, an expired record, or any other exit path that never drained
 * for one). Never claim `synced` without the specific evidence for this
 * exit; default to `unknown`, not `synced`.
 */
export const computerProcessSyncSchema = z.enum([
  "synced",
  "pending",
  "unknown",
]);
export type ComputerProcessSync = z.output<typeof computerProcessSyncSchema>;
export const computerProcessSchema = z.strictObject({
  id: computerProcessIdSchema,
  port: computerPortSchema.nullable(),
  command: z.string(),
  cwd: z.string().nullable(),
  state: computerProcessStateSchema,
  exitCode: z.number().int().nullable(),
  sync: computerProcessSyncSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type ComputerProcess = z.output<typeof computerProcessSchema>;
export const processListOutputSchema = z.strictObject({
  processes: z.array(computerProcessSchema).max(maximumProcessRecords),
});
export const processKillOutputSchema = z.strictObject({
  process: computerProcessSchema,
  signalled: z.boolean(),
});

/** No process with this id was started on this Computer. */
export class ComputerProcessNotFoundError extends Error {
  constructor(id: string) {
    super(`Computer process not found: ${id}`);
    this.name = "ComputerProcessNotFoundError";
  }
}

/** Every process slot is occupied by a running process. */
export class ComputerProcessLimitError extends Error {
  constructor() {
    super(
      `Computer process scope can run at most ${String(maximumRunningProcesses)} processes`,
    );
    this.name = "ComputerProcessLimitError";
  }
}
export type ComputerExecInput = z.output<typeof execInputSchema>;
export type ComputerExecRequest = z.output<typeof execRequestSchema>;
export type ComputerExecOutput = z.output<typeof execOutputSchema>;
export const computerOperationStatusSchema = z.enum([
  "accepted",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "expired",
]);
/** Durable operation status returned to the host that owns the request ID. */
export const computerOperationResultSchema = z.strictObject({
  requestId: computerRequestIdSchema,
  status: computerOperationStatusSchema,
  output: execOutputSchema.nullable(),
});
export type ComputerOperationResult = z.output<
  typeof computerOperationResultSchema
>;
/** Model-facing command result: the durable status without the host's ID. */
export const computerToolResultSchema = computerOperationResultSchema.omit({
  requestId: true,
});
export type ComputerToolResult = z.output<typeof computerToolResultSchema>;

/** Project one host operation result onto the model-facing tool result. */
export function computerToolResult(
  result: ComputerOperationResult,
): ComputerToolResult {
  return computerToolResultSchema.parse({
    status: result.status,
    output: result.output,
  });
}

/** Public operation vocabulary; transport adapters map these to routes. */
export const computerOperationSchema = z.enum([
  "files.read",
  "files.readBytes",
  "files.write",
  "files.writeBytes",
  "files.list",
  "files.glob",
  "files.grep",
  "files.edit",
  "files.patch",
  "mkdir",
  "bash",
  "exec",
]);
export type ComputerOperation = z.output<typeof computerOperationSchema>;

export type ComputerFileReplacement = z.output<typeof replaceInputSchema>;
export type ComputerFileReplacementResult = z.output<
  typeof replaceOutputSchema
>;

/** The expected file contents no longer match at atomic replacement. */
export class ComputerFileConflict extends Error {
  constructor() {
    super("Files edit conflict: contents changed before replacement");
    this.name = "ComputerFileConflict";
  }
}

/** A byte window starts beyond the current file extent. */
export class ComputerFileRangeError extends Error {
  constructor(readonly size: number) {
    super("Byte offset exceeds file size");
    this.name = "ComputerFileRangeError";
  }
}

/** The requested file bytes exceed the admitted read bound. */
export class ComputerFileTooLargeError extends Error {
  constructor() {
    super("File exceeds the Computer read bound");
    this.name = "ComputerFileTooLargeError";
  }
}

function capability(
  id: string,
  kind: string,
  description: string,
  input: z.ZodType,
  output: z.ZodType,
) {
  const parameters = structuredClone(z.toJSONSchema(input));
  const result = structuredClone(z.toJSONSchema(output));
  return computerValueSchema.parse({
    id,
    name: id,
    kind,
    description,
    parameters,
    output: result,
  });
}

let capabilities: z.output<typeof computerCapabilitiesSchema> | undefined;

/**
 * The operations every Computer advertises; static, so hosts can describe them
 * without a call. Built on first read: deriving JSON Schema for every operation
 * is real work that a Worker should not pay at startup.
 */
export function computerCapabilities(): z.output<
  typeof computerCapabilitiesSchema
> {
  capabilities ??= computerCapabilitiesSchema.parse([
    capability(
      "read",
      "fileStore",
      "Read one bounded UTF-8 file from this Computer.",
      readInputSchema,
      readOutputSchema,
    ),
    capability(
      "list",
      "fileStore",
      "List one bounded page of a directory on this Computer.",
      listInputSchema,
      listOutputSchema,
    ),
    capability(
      "mkdir",
      "fileStore",
      "Create a directory on this Computer.",
      mkdirInputSchema,
      mkdirOutputSchema,
    ),
    capability(
      "write",
      "fileStore",
      "Write one bounded UTF-8 file without creating its parent directory.",
      writeInputSchema,
      writeOutputSchema,
    ),
    capability(
      "bash",
      "runtime",
      "Run one bounded shell command in this Computer's Linux container, with node, npm and the programs installed there.",
      execInputSchema,
      computerToolResultSchema,
    ),
    capability(
      "exec",
      "runtime",
      "Run one bounded command in a lightweight Worker shell over this Computer's files. It has no node, npm or installed programs; use bash to run programs.",
      execInputSchema,
      computerToolResultSchema,
    ),
    capability(
      "start_process",
      "runtime",
      "Start one long-running command, such as a dev server, in this Computer's container. Returns its durable process id.",
      processStartToolInputSchema,
      computerProcessSchema,
    ),
    capability(
      "list_processes",
      "runtime",
      "List this Computer's started processes as running, exited or uncertain.",
      z.strictObject({}),
      processListOutputSchema,
    ),
    capability(
      "kill_process",
      "runtime",
      "Send SIGTERM to one running process on this Computer.",
      processIdInputSchema,
      processKillOutputSchema,
    ),
  ]);
  return capabilities;
}
