import { Buffer } from "node:buffer";

// Pure terminal wire helpers, kept free of node-pty so they test anywhere.

/** Output kept per session for replay on reconnect. */
export const replayBytes = 256 * 1_024;

export function boundedInteger(raw, minimum, maximum, fallback) {
  if (raw === null || !/^\d{1,4}$/.test(raw)) return fallback;
  const value = Number(raw);
  return value < minimum || value > maximum ? fallback : value;
}

/** Decode one client resize frame; any other text frame is ignored. */
export function parseResize(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (frame === null || Array.isArray(frame) || frame.type !== "resize")
    return null;
  const cols = boundedInteger(String(frame.cols), 2, 500, null);
  const rows = boundedInteger(String(frame.rows), 2, 300, null);
  return cols === null || rows === null ? null : { cols, rows };
}

/** Keep only the newest `limit` bytes of terminal output for replay. */
export class ReplayRing {
  #chunks = [];
  #bytes = 0;
  #limit;

  constructor(limit) {
    this.#limit = limit;
  }

  push(chunk) {
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#limit && this.#chunks.length > 0) {
      const excess = this.#bytes - this.#limit;
      const first = this.#chunks[0];
      if (first.byteLength <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.byteLength;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#bytes -= excess;
      }
    }
  }

  snapshot() {
    return Buffer.concat(this.#chunks, this.#bytes);
  }
}
