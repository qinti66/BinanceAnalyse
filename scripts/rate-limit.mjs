// Per-family sliding-window rate limiter for Binance requests.
//
// Why per family: Binance limits different endpoint families separately, and the existing collector spent ~4/6 of its requests on the
// /futures/data/ family at ~235 per minute against a 200/min (1000 per 5 min) cap. One global 170 ms throttle cannot respect two budgets.
//
// Boundary (same as scripts/binance-net.mjs): a rate limit is OBEYED, never worked around. HTTP 429 blocks every family until Retry-After
// has passed; HTTP 418 (an IP ban) and HTTP 403 (Binance's web application firewall limit was violated) abort the run. Nothing here rotates
// routes, IPs or exit nodes to get past a limit. A run stopped by 403 may be resumed later at a slower pace, once, and stops for good on a second 403.

/** Official caps with ~10% headroom. futuresData is per 5 minutes, the market families are request weight per minute. */
export const FAMILY_LIMITS = {
  futuresData: { limit: 900, windowMs: 300000, official: 1000 },
  umMarket: { limit: 2000, windowMs: 60000, official: 2400 },
  cmMarket: { limit: 2000, windowMs: 60000, official: 2400 },
  spot: { limit: 1000, windowMs: 60000, official: 1200 },
};

/** Weight of a klines request by its limit parameter. */
export const klinesWeight = (limit) => (limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1000 ? 5 : 10);

export class RateLimitAbort extends Error {
  constructor(status) {
    super(
      status === 403
        ? "HTTP 403: Binance's web application firewall limit was violated. Aborting the run; not retrying. Progress is kept; resume later, slower."
        : `HTTP ${status}: the IP is banned or blocked. Aborting the run; not retrying.`,
    );
    this.name = "RateLimitAbort";
    this.status = status;
  }
}

/** Throttle when the server-reported usage passes 80% of the official cap; restore below 50%. Halves the effective limit. */
export const THROTTLE_HIGH = 0.8;
export const THROTTLE_LOW = 0.5;

export class RateLimiter {
  constructor({ limits = FAMILY_LIMITS, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.limits = limits;
    this.now = now;
    this.sleep = sleep;
    this.events = Object.fromEntries(Object.keys(limits).map((k) => [k, []]));
    this.throttle = Object.fromEntries(Object.keys(limits).map((k) => [k, 1]));
    this.blockedUntil = 0;
    this.aborted = null;
  }

  effectiveLimit(family) {
    return this.limits[family].limit * this.throttle[family];
  }

  /** Cost currently inside the family's window. */
  used(family) {
    const cutoff = this.now() - this.limits[family].windowMs;
    this.events[family] = this.events[family].filter((e) => e.t > cutoff);
    return this.events[family].reduce((a, e) => a + e.cost, 0);
  }

  /** Wait until `cost` fits in the family's window and no global block is active, then record it. */
  async acquire(family, cost = 1) {
    if (!this.limits[family]) throw new Error("unknown rate limit family: " + family);
    if (this.aborted) throw this.aborted;
    if (!(cost > 0)) throw new Error("cost must be positive");
    if (cost > this.effectiveLimit(family)) throw new Error(`a request of cost ${cost} can never fit in ${family} (limit ${this.effectiveLimit(family)})`);
    for (;;) {
      if (this.aborted) throw this.aborted;
      const t = this.now();
      if (t < this.blockedUntil) {
        await this.sleep(this.blockedUntil - t);
        continue;
      }
      if (this.used(family) + cost <= this.effectiveLimit(family)) break;
      const oldest = this.events[family][0];
      await this.sleep(Math.max(1, oldest.t + this.limits[family].windowMs - t));
    }
    this.events[family].push({ t: this.now(), cost });
  }

  /** Feed back the server's own count (e.g. the X-MBX-USED-WEIGHT-1M header) for a weighted family. */
  feedback(family, usedWeight) {
    if (!Number.isFinite(usedWeight)) return;
    const ratio = usedWeight / this.limits[family].official;
    if (ratio > THROTTLE_HIGH) this.throttle[family] = 0.5;
    else if (ratio < THROTTLE_LOW) this.throttle[family] = 1;
  }

  /**
   * Report an HTTP status. 429: block every family until Retry-After (at least 1 s) has passed. 418 and 403: abort the whole run.
   * Returns true when the caller must wait and may then retry, false for any other status.
   */
  onStatus(status, retryAfterSec) {
    if (status === 418 || status === 403) {
      this.aborted = new RateLimitAbort(status);
      throw this.aborted;
    }
    if (status === 429) {
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(1, Number(retryAfterSec) || 60) * 1000);
      return true;
    }
    return false;
  }
}
