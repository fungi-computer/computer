/** The Computer ceiling shared by the platform image and on-box host. */
export const computerResourceBounds = Object.freeze({
  vcpus: 4,
  memoryMib: 12_288,
  diskGib: 20,
  pidsMax: 256,
  maxRuntimeMs: 24 * 60 * 60 * 1_000,
});

/** Proofs may shorten a runtime, but no start may extend the ceiling. */
export function boundedRuntimeMs(value) {
  if (value === undefined) return computerResourceBounds.maxRuntimeMs;
  return boundedInteger(
    "runtime deadline",
    Number(value),
    1_000,
    computerResourceBounds.maxRuntimeMs,
  );
}

function boundedInteger(name, value, minimum, maximum) {
  const valid = Number.isInteger(value) && value >= minimum && value <= maximum;
  if (!valid) throw new Error(`Computer ${name} exceeds its resource bound`);
  return value;
}

export function computerRuntimeExpired(startedAt, now, maximumRuntimeMs) {
  return now - startedAt >= maximumRuntimeMs;
}

/** The host may provision a smaller VM, never a larger Computer. */
export function boundedVmResources({ vcpus, memMib, diskGib, pidsMax }) {
  return {
    vcpus: boundedInteger("vcpus", vcpus, 1, computerResourceBounds.vcpus),
    memMib: boundedInteger(
      "memMib",
      memMib,
      1,
      computerResourceBounds.memoryMib,
    ),
    diskGib: boundedInteger(
      "diskGib",
      diskGib,
      1,
      computerResourceBounds.diskGib,
    ),
    pidsMax: boundedInteger(
      "pidsMax",
      pidsMax,
      1,
      computerResourceBounds.pidsMax,
    ),
  };
}
