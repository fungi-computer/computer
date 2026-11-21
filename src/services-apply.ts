import { z } from "zod";
import type {
  ComputerServiceInventory,
  ComputerServicesApply,
} from "./services.js";

/** The command result `applyDeclaredServices` needs from the Computer's exec path. */
export type ServicesCommandResult = Readonly<{
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

/** How a `fungi-services` command failed: its kind, and the last line it wrote. */
const servicesFailureSchema = z.strictObject({
  failure: z.enum(["refused", "missing", "timeout", "other"]),
  detail: z.string(),
});
export type ComputerServicesFailure = z.output<typeof servicesFailureSchema>;

/**
 * The failure `fungi-services` reported on stderr. A command that wrote none
 * (a crash, a stopped runtime) is `other`, with the last line it wrote.
 */
export function servicesFailureOf(
  result: ServicesCommandResult,
): ComputerServicesFailure {
  const last = result.stderr.trim().split("\n").at(-1) ?? "";
  try {
    return servicesFailureSchema.parse(JSON.parse(last));
  } catch {
    return { failure: "other", detail: last };
  }
}

/** `fungi-services apply` did not finish; the Computer's services may be stopped. */
export class ComputerServicesApplyError extends Error {
  readonly result: ServicesCommandResult;
  constructor(result: ServicesCommandResult) {
    super(
      `Computer services could not be applied (${result.status}, exit ${String(result.exitCode)}): ${result.stderr.slice(0, 500)}`,
    );
    this.name = "ComputerServicesApplyError";
    this.result = result;
  }
}

/** A read or control command of `fungi-services` did not finish. */
export class ComputerServicesCommandError extends Error {
  readonly result: ServicesCommandResult;
  constructor(operation: string, result: ServicesCommandResult) {
    super(
      `Computer services ${operation} failed (${result.status}, exit ${String(result.exitCode)}): ${result.stderr.slice(0, 500)}`,
    );
    this.name = "ComputerServicesCommandError";
    this.result = result;
  }
}

/**
 * The shell command that hands `fungi-services apply` the declarations. The
 * JSON travels as base64, which holds only characters a single-quoted word
 * keeps literal, so no declared byte reaches the shell as syntax.
 */
export function servicesApplyCommand(payload: ComputerServicesApply): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(payload)))
    binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  return `printf %s '${encoded}' | base64 -d | fungi-services apply`;
}

/**
 * Bring a runtime to the declared services: re-admit their ports, then render
 * and start them. On a fresh runtime a Computer with nothing declared runs
 * nothing, because its scan directory is already empty; a live runtime that
 * just lost its last declaration still needs the apply that stops it, so a
 * caller that changed a declaration passes `whenEmpty: "run"`.
 */
export async function applyDeclaredServices(options: {
  inventory: ComputerServiceInventory;
  run: (command: string) => Promise<ServicesCommandResult>;
  whenEmpty?: "run" | "skip";
}): Promise<"applied" | "none"> {
  options.inventory.ensurePorts();
  const payload = options.inventory.applyPayload();
  if (payload.services.length === 0 && options.whenEmpty !== "run")
    return "none";
  const result = await options.run(servicesApplyCommand(payload));
  if (result.status !== "completed" || result.exitCode !== 0)
    throw new ComputerServicesApplyError(result);
  return "applied";
}
