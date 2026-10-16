import type { ComputerAction, ComputerGrant } from "./wire.js";

/** The fleet's decision contains no host policy or host lookup. */
export type ComputerAdmission =
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "Refused"; reason: "computer" | "action" | "expired" }>;

/** Check authority supplied by the host at its door, using the fleet's clock. */
export function checkComputerGrant(
  grant: ComputerGrant,
  request: Readonly<{
    computerId: string;
    action: ComputerAction;
    now: number;
  }>,
): ComputerAdmission {
  if (grant.computerId !== request.computerId)
    return { kind: "Refused", reason: "computer" };
  if (!grant.actions.has(request.action))
    return { kind: "Refused", reason: "action" };
  if (request.now >= grant.expiresAt)
    return { kind: "Refused", reason: "expired" };
  return { kind: "admitted" };
}
