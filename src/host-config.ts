import { z } from "zod";

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
