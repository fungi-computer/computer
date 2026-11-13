/**
 * What each Computer size gives an on-box VM. The names match
 * `computerSizeSchema` in `src/computer-backends.ts`, which a test pins.
 */
export const computerSizes = Object.freeze({
  small: Object.freeze({ vcpus: 2, memoryMib: 4_096 }),
  default: Object.freeze({ vcpus: 4, memoryMib: 8_192 }),
  large: Object.freeze({ vcpus: 8, memoryMib: 16_384 }),
});

/** A Cloudflare `standard-4` instance: the platform container's one size. */
export const platformContainerResources = Object.freeze({
  vcpus: 4,
  memoryMib: 12_288,
});

/** The ceiling shared by the platform image and on-box host: the largest size. */
export const computerResourceBounds = Object.freeze({
  vcpus: computerSizes.large.vcpus,
  memoryMib: computerSizes.large.memoryMib,
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

/** The VM resources one size selects, refusing a name that is not a size. */
export function computerSizeResources(size) {
  if (!Object.hasOwn(computerSizes, size))
    throw new Error(`Computer size ${String(size)} is not offered`);
  const { vcpus, memoryMib } = computerSizes[size];
  return { vcpus, memMib: memoryMib };
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
