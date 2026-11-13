import { z } from "zod";
import type { ComputerSize } from "./computer-backends.js";

/**
 * What one running VM of each size counts against a host's capacity, in
 * half-default-VM units: the configured memory in 4 GiB steps (4, 8 and 16
 * GiB). Configured memory bounds what a busy guest can pin, where the measured
 * resident size of an idle VM (about 0.43 GiB) bounds nothing. A host's
 * `maxActive` and `reservedHeadroom` still count default-size VMs, so a host
 * admits the same number of default VMs as before, twice as many small ones and
 * half as many large ones.
 */
export const computerSizeUnits = {
  small: 1,
  default: 2,
  large: 4,
} as const satisfies Record<ComputerSize, number>;
/** Units one default-size VM holds: the factor between `maxActive` and units. */
export const unitsPerDefaultVm = computerSizeUnits.default;

/** One VM host's active capacity, including slots held back as headroom. */
export const hostCapacitySchema = z
  .strictObject({
    maxActive: z.number().int().positive(),
    reservedHeadroom: z.number().int().nonnegative(),
  })
  .refine((value) => value.reservedHeadroom < value.maxActive);

/** Public Computer host capacity configuration, keyed by registered host ID. */
export const hostCapacityRegistrySchema = z.record(
  z.string(),
  hostCapacitySchema,
);
export type HostCapacity = z.infer<typeof hostCapacitySchema>;
