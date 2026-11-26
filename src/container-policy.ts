import { z } from "zod";

/**
 * The one idle window: a Computer with no operation in flight, no open
 * terminal, no command Fungi started that is still running and no traffic the
 * host sees to its VM is stopped this long after its last activity, freeing its
 * host slot. Its files are saved first and it starts again on its next use.
 * An Agent that is only thinking, with no command running, does not hold it.
 */
export const computerContainerSleepAfterMs = 10 * 60 * 1_000;
/**
 * The platform's own inactivity kill, a backstop well above the idle window: it
 * saves nothing and cannot see what the Hub counts, so the Hub's save-then-stop
 * must always come first.
 */
export const computerPlatformBackstopMs = 60 * 60 * 1_000;
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
    keepAwake ? computerKeepAwakeTimeoutMs : computerPlatformBackstopMs,
  );
}
