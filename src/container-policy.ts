import { z } from "zod";

/** The one idle window: a Computer sleeps this long after its last activity. */
export const computerContainerSleepAfterMs = 15 * 60 * 1_000;
/** A kept-awake container's platform backstop: the 24 hour runtime ceiling. */
export const computerKeepAwakeTimeoutMs = 24 * 60 * 60 * 1_000;

const hostedComputersSchema = z
  .enum(["enabled", "paused"])
  .default("enabled")
  .catch("paused");

export function hostedComputerContainersPaused(
  hostedComputers: string | undefined,
): boolean {
  return hostedComputersSchema.parse(hostedComputers) === "paused";
}

export class ComputerContainersPausedError extends Error {
  constructor() {
    super("Hosted Computer containers are paused");
    this.name = "ComputerContainersPausedError";
  }
}

export function assertComputerContainersEnabled(
  hostedComputers: string | undefined,
): void {
  if (hostedComputerContainersPaused(hostedComputers))
    throw new ComputerContainersPausedError();
}

/** The platform inactivity timeout is a backstop; ComputerDO owns idle sleep. */
export async function configureComputerContainer(
  container: Pick<Container, "setInactivityTimeout"> | undefined,
  keepAwake: boolean,
): Promise<void> {
  if (container === undefined)
    throw new Error("Computer Durable Object is not container-enabled");
  await container.setInactivityTimeout(
    keepAwake ? computerKeepAwakeTimeoutMs : computerContainerSleepAfterMs,
  );
}
