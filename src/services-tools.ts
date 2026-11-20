import {
  ComputerServiceNotFoundError,
  computerServiceViewSchema,
  computerServiceNameSchema,
  maximumProcessLogLines,
  serviceLogsOutputSchema,
  type serviceListOutputSchema,
} from "@fungi.computer/computer-contract";
import { z } from "zod";
import {
  applyDeclaredServices,
  ComputerServicesCommandError,
  type ServicesCommandResult,
} from "./services-apply.js";
import type {
  ComputerService,
  ComputerServiceDeclaration,
  ComputerServiceInventory,
} from "./services.js";

/** What the Agent tools need of a Computer: whether it is awake, and a command run on it. */
export type ServicesRuntime = Readonly<{
  /** True only while a hosted runtime is running; asking never starts one. */
  awake: () => Promise<boolean>;
  run: (command: string) => Promise<ServicesCommandResult>;
}>;

export type ComputerServiceView = z.output<typeof computerServiceViewSchema>;
export type ComputerServiceList = z.output<typeof serviceListOutputSchema>;

const supervisorStatus = z.strictObject({
  services: z.record(
    computerServiceNameSchema,
    z.strictObject({
      state: z.enum(["up", "restarting", "down"]),
      pid: z.number().int().positive().optional(),
      seconds: z.number().int().nonnegative().optional(),
    }),
  ),
});
const logTail = serviceLogsOutputSchema;

async function command(
  runtime: ServicesRuntime,
  operation: string,
  text: string,
): Promise<string> {
  const result = await runtime.run(text);
  if (result.status !== "completed" || result.exitCode !== 0)
    throw new ComputerServicesCommandError(operation, result);
  return result.stdout;
}

/** Render and start what is declared, now, but only on a runtime that already runs. */
async function applyWhileAwake(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
): Promise<boolean> {
  if (!(await runtime.awake())) return false;
  await applyDeclaredServices({
    inventory,
    run: (text) => runtime.run(text),
    whenEmpty: "run",
  });
  return true;
}

async function views(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
): Promise<readonly ComputerServiceView[]> {
  const declared = inventory.list();
  const awake = await runtime.awake();
  const live = awake
    ? supervisorStatus.parse(
        JSON.parse(await command(runtime, "status", "fungi-services status")),
      ).services
    : {};
  return declared.map((service) =>
    computerServiceViewSchema.parse({
      ...service,
      status: !awake
        ? { state: "asleep" }
        : (live[service.name] ??
            // Declared and enabled but not rendered yet, or stopped and not rendered.
            { state: service.enabled ? "restarting" : "down" }),
    }),
  );
}

async function viewOf(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
  service: ComputerService,
): Promise<ComputerServiceView> {
  const found = (await views(inventory, runtime)).find(
    (view) => view.name === service.name,
  );
  if (found === undefined) throw new ComputerServiceNotFoundError(service.name);
  return found;
}

/** `list_services`: every declaration with its live status; reading never wakes the Computer. */
export async function listServices(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
): Promise<ComputerServiceList> {
  return { services: [...(await views(inventory, runtime))] };
}

/** `declare_service`: save, then start now if the Computer is awake. */
export async function declareService(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
  input: ComputerServiceDeclaration,
  declaredBy: string,
): Promise<ComputerServiceView> {
  const service = inventory.declare(input, declaredBy);
  await applyWhileAwake(inventory, runtime);
  return viewOf(inventory, runtime, service);
}

/** `stop_service` and `start_service`: change whether it is declared as running. */
export async function setServiceEnabled(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
  name: string,
  enabled: boolean,
): Promise<ComputerServiceView> {
  const service = inventory.setEnabled(name, enabled);
  await applyWhileAwake(inventory, runtime);
  return viewOf(inventory, runtime, service);
}

/** `restart_service`: apply first, then restart one that was already declared to run. */
export async function restartService(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
  name: string,
): Promise<ComputerServiceView> {
  const before = inventory.get(name);
  if (before === undefined) throw new ComputerServiceNotFoundError(name);
  const service = inventory.setEnabled(name, true);
  if (await applyWhileAwake(inventory, runtime))
    if (before.enabled)
      await command(runtime, "restart", `fungi-services restart ${name}`);
  return viewOf(inventory, runtime, service);
}

/** `remove_service`: forget it, stopping it if the Computer is awake. */
export async function removeService(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
  name: string,
): Promise<{ name: string; removed: true }> {
  inventory.remove(name);
  await applyWhileAwake(inventory, runtime);
  return { name, removed: true };
}

/** `service_logs`: the newest lines, kept only while the Computer is awake. */
export async function serviceLogs(
  inventory: ComputerServiceInventory,
  runtime: ServicesRuntime,
  input: { name: string; lines?: number | undefined },
): Promise<z.output<typeof serviceLogsOutputSchema>> {
  if (inventory.get(input.name) === undefined)
    throw new ComputerServiceNotFoundError(input.name);
  if (!(await runtime.awake()))
    return { name: input.name, lines: [], truncated: false };
  const lines = input.lines ?? maximumProcessLogLines;
  return logTail.parse(
    JSON.parse(
      await command(
        runtime,
        "logs",
        `fungi-services logs ${input.name} ${String(lines)}`,
      ),
    ),
  );
}
