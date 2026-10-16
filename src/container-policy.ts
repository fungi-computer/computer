import { z } from "zod";

export const computerContainerSleepAfterMs = 15 * 60 * 1_000;

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

export async function configureComputerContainer(
  container: Pick<Container, "setInactivityTimeout"> | undefined,
): Promise<void> {
  if (container === undefined)
    throw new Error("Computer Durable Object is not container-enabled");
  await container.setInactivityTimeout(computerContainerSleepAfterMs);
}
