import type {
  SyncRetryIntent,
  SyncRetryScheduler,
} from "@fungi.computer/cloudflare-computer";

/**
 * A faithful, in-memory delegate for `@cloudflare/computer`'s own
 * `retryScheduler` option: the library's documented host-owned durable
 * storage boundary for a post-command pull that failed (`onPullPending`,
 * from `runPostPull`'s catch branch -- "the workspace library cannot own
 * a Durable Object alarm"). `get`, `schedule` and `clear` store and return
 * the library's real intents, so its own dedup-by-runtimeId and
 * exponential backoff (`Workspace.retryPendingSync`) stay correct for
 * whoever wires an alarm to drive it. A wrapper that invents its own
 * signal instead -- for example, one whose `get` always reports no
 * existing intent, to make the library call `schedule` on every failure
 * -- would break that dedup and backoff for an actual retry.
 *
 * This Computer does not yet call `retryPendingSync` from anywhere (no
 * Durable Object alarm is wired to it), so a pending backend only clears
 * when that retry runs and succeeds; it does not self-heal if the
 * underlying problem goes away on its own. It is also in-memory only: it
 * does not survive a Durable Object eviction. Both are known, bounded
 * limitations, not a second compatibility path -- the real fix is wiring
 * an alarm to `retryPendingSync`, a separate change.
 */
export class PullPendingTracker {
  readonly #intents = new Map<string, SyncRetryIntent>();

  readonly scheduler: SyncRetryScheduler = {
    get: (backend) => Promise.resolve(this.#intents.get(backend)),
    schedule: (intent) => {
      this.#intents.set(intent.backend, intent);
      return Promise.resolve();
    },
    clear: (backend) => {
      this.#intents.delete(backend);
      return Promise.resolve();
    },
  };
}
