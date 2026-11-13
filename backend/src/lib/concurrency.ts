// backend/src/lib/concurrency.ts
//
// Inline concurrency limiter — deliberately no p-limit dependency. Born from
// the tabular-review generate fan-out: POST /:reviewId/generate launched one
// download + extract + LLM pipeline per document simultaneously, so a
// 50-document review meant 50 concurrent R2 downloads and 50 concurrent LLM
// streams from a single request.

/**
 * Parse a positive integer from the environment, falling back otherwise.
 * Lives in lib (not index.ts) so route/lib code can use it without
 * importing the app entrypoint, which has side effects on load.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A standing gate: hand it a task, get the task's result once a slot is free.
 * See createConcurrencyGate for the contract.
 */
export type ConcurrencyGate = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A *standing* gate for individual calls, as opposed to mapWithConcurrency,
 * which paces one known batch. Callers arrive independently and at arbitrary
 * times (a signature render, an upload conversion, a transcript PDF), so
 * there is no list to map over — each call asks for a slot and waits its turn.
 *
 * Contract (pinned by concurrency.test.ts):
 * - At most `limit` tasks run at once; a limit < 1 clamps to 1.
 * - Waiters are admitted strictly FIFO, so no caller can be starved.
 * - The slot is released even when the task throws, and the rejection is
 *   passed through untouched.
 * - A freed slot is handed directly to the next waiter rather than being
 *   returned to the pool, so a caller arriving synchronously in between
 *   cannot jump the queue and push the in-flight count over the limit.
 */
export function createConcurrencyGate(limit: number): ConcurrencyGate {
  const effectiveLimit =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const waiting: (() => void)[] = [];
  let active = 0;

  const release = (): void => {
    const next = waiting.shift();
    // Hand the slot over instead of decrementing: `active` stays claimed so
    // the gap between waking the waiter and its continuation running is not
    // an opening for someone else.
    if (next) next();
    else active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= effectiveLimit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Map `items` through `fn` with at most `limit` invocations in flight.
 *
 * Contract (pinned by concurrency.test.ts):
 * - Results are returned in input order, regardless of completion order.
 * - One item's rejection never prevents the remaining items from running —
 *   every item settles. The first rejection is rethrown afterwards, so a
 *   caller that previously wrapped Promise.all in try/catch still sees a
 *   single error.
 * - A limit < 1 clamps to 1 (sequential) rather than running nothing.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effectiveLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const results = new Array<R>(items.length);
  const errors: unknown[] = [];
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(effectiveLimit, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index], index);
        } catch (err) {
          errors.push(err);
        }
      }
    },
  );

  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
  return results;
}
