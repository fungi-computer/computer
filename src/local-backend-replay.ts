import type {
  SeamReplayAdmission,
  SeamReplayRecord,
  SeamReplayStore,
} from "@fungi.computer/seam";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

/** Private receiver-local storage ceiling, not a Team or attachment quota. */
export const maximumLocalDialReplayRecords = 4096;

const countSchema = z.number().int().nonnegative();

/**
 * One Computer's local-dial receiver history, in its existing owner database.
 * Reconstruct with the same owner, never a process-generation namespace.
 * Native SQLite owns atomicity and commit; there is no in-memory fallback.
 */
export function createLocalBackendReplayStore(
  owner: WatchdogSqliteOwner,
): SeamReplayStore {
  return {
    admit({ nonce, now, expiresAt }: SeamReplayRecord) {
      try {
        return owner.transactionSync<SeamReplayAdmission>(() => {
          owner.sql
            .exec(`CREATE TABLE IF NOT EXISTS computer_local_dial_replay (
            nonce TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL
          ) STRICT`);
          // Seam's last fresh instant is inclusive. Do not renew duplicate
          // deadlines, assume expiry order, or discard any still-live record.
          owner.sql.exec(
            "DELETE FROM computer_local_dial_replay WHERE expires_at < ?",
            now,
          );
          if (
            owner.sql
              .exec(
                "SELECT nonce FROM computer_local_dial_replay WHERE nonce = ?",
                nonce,
              )
              .toArray().length > 0
          )
            return "replayed";
          const count = countSchema.parse(
            owner.sql
              .exec("SELECT COUNT(*) AS count FROM computer_local_dial_replay")
              .toArray()[0]?.count,
          );
          if (count >= maximumLocalDialReplayRecords) return "at-capacity";
          owner.sql.exec(
            "INSERT INTO computer_local_dial_replay (nonce, expires_at) VALUES (?, ?)",
            nonce,
            expiresAt,
          );
          return "admitted";
        });
      } catch {
        // Covers schema, decoding, statement and commit failures. SQLite rolls
        // back a failed transaction; no successful admission escapes it.
        return "unavailable";
      }
    },
  };
}
