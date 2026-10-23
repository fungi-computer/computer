import {
  execTruncationMarker,
  maximumStreamBytes,
  truncationMarkerReserveBytes,
  utf8Prefix,
  type ComputerExecTruncation,
} from "@fungi.computer/computer-contract";

const utf8 = new TextEncoder();
const noTruncation: readonly ComputerExecTruncation[] = [];

/**
 * Keep one command stream within `maximumStreamBytes`. A cut stream ends with
 * a visible marker line (counted inside the bound, excluded from the totals)
 * and reports a typed entry.
 */
export function boundExecStream(value: string, stream: "stdout" | "stderr") {
  const bytes = utf8.encode(value);
  if (bytes.byteLength <= maximumStreamBytes) {
    return { value, truncation: noTruncation };
  }
  const kept = utf8Prefix(
    bytes,
    maximumStreamBytes - truncationMarkerReserveBytes,
  );
  const entry = {
    stream,
    keptBytes: kept.byteLength,
    totalBytes: bytes.byteLength,
  };
  return {
    value: `${new TextDecoder().decode(kept)}${execTruncationMarker(entry)}`,
    truncation: [entry],
  };
}
