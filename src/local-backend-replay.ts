import type {
  SeamReplayAdmission,
  SeamReplayRecord,
  SeamReplayStore,
} from "@fungi.computer/seam";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";

/**
 * Private receiver-local storage ceiling for ONE backend's live dial history,
 * not a Team or attachment quota. Each attached backend has its own share, so a
 * backend that reaches it is refused alone; a Computer's total is bounded by
 * its attached-backend limit times this.
 */
export const maximumLocalDialReplayRecords = 4096;

const countSchema = z.number().int().nonnegative();
const definitionSchema = z.object({ sql: z.string() });

/**
 * One backend's share of a Computer's local-dial receiver history, in its
 * existing owner database. A nonce is a replay whichever backend first used
 * it, but only `backendId`'s own live records count toward its capacity.
 * Reconstruct with the same owner and backend, never a process-generation
 * namespace. Native SQLite owns atomicity and commit; there is no in-memory
 * fallback.
 */
export function createLocalBackendReplayStore(
  owner: WatchdogSqliteOwner,
  backendId: string,
): SeamReplayStore {
  return {
    admit({ nonce, now, expiresAt }: SeamReplayRecord) {
      try {
        return owner.transactionSync<SeamReplayAdmission>(() => {
          // Pre-release data is disposable: a table without `backend_id` is
          // dropped and recreated in the current shape. Its nonces are dials
          // that expire within Seam's 120 s window (two 60 s skews), the
          // bounded span in which one of them could be replayed.
          const existing = definitionSchema
            .optional()
            .parse(
              owner.sql
                .exec(
                  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'computer_local_dial_replay'",
                )
                .toArray()[0],
            );
          if (existing !== undefined && !existing.sql.includes("backend_id"))
            owner.sql.exec("DROP TABLE computer_local_dial_replay");
          owner.sql
            .exec(`CREATE TABLE IF NOT EXISTS computer_local_dial_replay (
            nonce TEXT PRIMARY KEY,
            backend_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          ) STRICT`);
          owner.sql.exec(
            "CREATE INDEX IF NOT EXISTS computer_local_dial_replay_backend ON computer_local_dial_replay (backend_id)",
          );
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
              .exec(
                "SELECT COUNT(*) AS count FROM computer_local_dial_replay WHERE backend_id = ?",
                backendId,
              )
              .toArray()[0]?.count,
          );
          if (count >= maximumLocalDialReplayRecords) return "at-capacity";
          owner.sql.exec(
            "INSERT INTO computer_local_dial_replay (nonce, backend_id, expires_at) VALUES (?, ?, ?)",
            nonce,
            backendId,
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
