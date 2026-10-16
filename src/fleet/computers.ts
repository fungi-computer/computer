import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import type { HostedBacking } from "../computer-backends.js";
import { createFleetInventory } from "./inventory.js";
import { createFleetBacking } from "./backing.js";
import { createFleetSlots } from "./slots.js";
import type { FleetActor, ComputerCreateRequest } from "./inventory-wire.js";

/** Durable collection owner. Host decisions enter as data; projections leave in the result. */
export function createFleetComputers(
  owner: WatchdogSqliteOwner,
  capacity: Readonly<{ limit: number; retryAfterSeconds: number }>,
) {
  const inventory = createFleetInventory(owner);
  const backing = createFleetBacking(owner);
  const slots = createFleetSlots(owner, capacity);
  return {
    ensure: () => {
      owner.transactionSync(() => {
        inventory.ensure();
        backing.ensure();
        slots.ensure();
      });
    },
    read: inventory.read,
    list: inventory.list,
    count: inventory.count,
    ids: inventory.ids,
    /** A replay preserves the original decision and stages nothing. */
    create: (
      actor: FleetActor,
      request: ComputerCreateRequest,
      backings: readonly HostedBacking[],
    ) =>
      owner.transactionSync(() => {
        const prior = inventory.replay(actor, request);
        if (prior !== null) return { computer: prior, projections: [] };
        const computer = inventory.create(actor, request);
        const projection = backing.computerCreated(
          computer.computerId,
          backings,
        );
        return { computer, projections: [projection] };
      }),
    readBacking: (computerId: string) =>
      inventory.read(computerId) === null ? null : backing.resolve(computerId),
    reserveSlot: slots.reserve,
    releaseSlot: slots.release,
    runningCount: slots.count,
  };
}
