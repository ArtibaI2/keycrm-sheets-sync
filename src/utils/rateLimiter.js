/**
 * Sliding-window rate limiter + retry helper for APIs with strict RPM limits
 * (KeyCRM allows up to 20 requests/minute per API key).
 */
export class RateLimiter {
  constructor({ maxRequestsPerMinute = 18, minDelayMs = 200, sleepFn } = {}) {
    this.maxRequests = maxRequestsPerMinute;
    this.windowMs = 60_000;
    this.minDelayMs = minDelayMs;
    this.timestamps = [];
    this.lastRequestAt = 0;
    this.queue = Promise.resolve();
    this.sleep = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Schedules an async function respecting both minDelayMs and maxRequests/min.
   */
  schedule(fn) {
    const run = this.queue.then(async () => {
      await this.#waitForSlot();
      return fn();
    });
    // Keep queue alive even if a single task rejects
    this.queue = run.catch(() => {});
    return run;
  }

  async #waitForSlot() {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

      const sinceLast = now - this.lastRequestAt;
      if (sinceLast < this.minDelayMs) {
        await this.sleep(this.minDelayMs - sinceLast);
        continue;
      }

      if (this.timestamps.length >= this.maxRequests) {
        const oldest = this.timestamps[0];
        const waitMs = Math.max(50, this.windowMs - (now - oldest) + 50);
        await this.sleep(waitMs);
        continue;
      }

      const stamp = Date.now();
      this.timestamps.push(stamp);
      this.lastRequestAt = stamp;
      return;
    }
  }
}
