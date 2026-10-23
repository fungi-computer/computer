import { z } from "zod";

/** Opaque host identity; the fleet does not interpret the actor kind. */
export type FleetActor = Readonly<{ kind: string; id: string }>;
/** A Computer's public inventory record. */
export type FleetComputer = Readonly<{
  computerId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}>;
/** A durable create receipt binds the complete request to its actor. */
export const computerCreateRequestSchema = z.strictObject({
  name: z.string().min(1).max(256).optional(),
  requestId: z.string().min(1).max(256),
});
export type ComputerCreateRequest = Readonly<{
  name?: string | undefined;
  requestId: string;
}>;
/** Inventory pages retain stable ordering and a bounded response. */
export const computerPageSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(100),
  offset: z.number().int().nonnegative().default(0),
});
export type ComputerPage = z.input<typeof computerPageSchema>;
/** Inventory failures, independent of a host's public error mapping. */
export class ComputerInventoryError extends Error {
  constructor(
    readonly code: "partial_init" | "request_conflict" | "name_taken",
  ) {
    super(`Computer inventory refused: ${code}`);
    this.name = "ComputerInventoryError";
  }
}
